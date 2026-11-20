from datetime import timedelta
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from docx import Document
from sqlalchemy import select

from app.db import (Booking, BookingChange, BookingDocument, BookingHandover, EquipmentFeature,
                    InventoryAudit, NotificationDelivery, ReceiptArchive, Session, TrustedSigner)
from app.booking_changes import change_view, process_change_deadlines, propose_change, update_request
from app.handover import customer_attest, attest_paper_signature, handover_state, record_return_finding
from app.inventory import save_feature, save_owner, inventory_details
from app.rental import (Conflict, assign_booking_assets, availability, create_booking, get_booking,
                        now, record_inspection, return_for_rework, transition)
from app.receipt_archive import customer_receipt_pdf, purge_expired_receipts
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data
from tests.workflow_helpers import verified_identity, paper, returning


def ready_booking(monkeypatch, partial=False):
    configure(monkeypatch)
    import app.schedule as schedule
    from datetime import datetime
    from zoneinfo import ZoneInfo
    monkeypatch.setenv("ENFORCE_HANDOVER_SCHEDULE","true")
    monkeypatch.setattr(schedule,"current_time",lambda:datetime(2026,10,29,12,tzinfo=ZoneInfo("Europe/Moscow")))
    from app.db import StaffRole
    with Session.begin() as session:
        session.get(StaffRole,200).role = "operator"
    article = article_with_assets("COMPLETE", 2)
    start = schedule.next_working_slot(now() + timedelta(days=5))
    end = schedule.next_working_slot(start + timedelta(days=1))
    booking_id = create_booking(42, "Клиент", "@synthetic", start, end, [{"article_id":article,"quantity":2}])
    transition(booking_id, "confirmed", 100)
    verified_identity(booking_id)
    booking = get_booking(booking_id)
    exceptions = [{"line_id":booking.lines[0].id,"reason":"missing","note":"Не поступил"}] if partial else []
    assign_booking_assets(booking_id,100,exceptions=exceptions)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id,asset.equipment_id,"pre_issue","pass",{},"",100)
    return booking_id


def test_last_equipment_cannot_be_removed_in_preparation(monkeypatch):
    from app.rental import set_booking_asset_deleted
    booking_id = ready_booking(monkeypatch)
    booking = get_booking(booking_id)
    # Return to preparation and remove one of the two assigned units.
    set_booking_asset_deleted(booking_id, booking.assets[0].equipment_id, 100, True)
    remaining = get_booking(booking_id).assets
    assert len(remaining) == 1
    with pytest.raises(Conflict, match="последнюю единицу"):
        set_booking_asset_deleted(booking_id, remaining[0].equipment_id, 100, True)


def test_full_cycle_docx_is_atomic_immutable_and_survives_identity_removal(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    asset_id = get_booking(booking_id).assets[0].equipment_id
    feature_id = save_feature(asset_id,"Царапина на корпусе",100)
    transition(booking_id,"ready",100)
    original = customer_receipt_pdf(booking_id,42)[0]
    text = "\n".join(p.text for p in Document(BytesIO(original)).paragraphs)
    assert "Приложение к сохранной расписке" in text and "Царапина на корпусе" in text
    assert handover_state(booking_id)["snapshot"][0]["features"][0]["description"] == "Царапина на корпусе"
    assert customer_receipt_pdf(booking_id,42)[0] == original
    with pytest.raises(Conflict): customer_attest(booking_id,42,"received")
    with pytest.raises(ValueError): customer_attest(booking_id,43,"received")
    transition(booking_id,"issued",200, actor_name="Оператор Выдачи")
    with pytest.raises(Conflict): customer_attest(booking_id,42,"received")
    assert handover_state(booking_id)["issued_by_name"] == "Оператор Выдачи"
    save_feature(asset_id,"Изменённая карточка",100,feature_id)
    assert customer_receipt_pdf(booking_id,42)[0]==original
    with pytest.raises(Conflict): transition(booking_id,"return_inspection",100)
    returning(booking_id)
    transition(booking_id,"return_inspection",100)
    with pytest.raises(Conflict): transition(booking_id,"returned",100)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id,asset.equipment_id,"check_in","pass",{},"",200)
    transition(booking_id,"returned",200, actor_name="Оператор Приёмки")
    assert handover_state(booking_id)["returned_by_name"] == "Оператор Приёмки"
    from app.pii import delete_identity
    delete_identity(booking_id,200)
    assert customer_receipt_pdf(booking_id,42)[0] == original
    with Session() as session:
        assert session.get(BookingDocument,(booking_id,"issue")) is None
        expiry = session.get(ReceiptArchive,booking_id).expires_at
        assert session.scalar(select(NotificationDelivery.id).where(NotificationDelivery.booking_id==booking_id,NotificationDelivery.event=="booking_update"))
    assert purge_expired_receipts(expiry) == 1
    assert handover_state(booking_id)["issued_by"] == 200
    assert handover_state(booking_id)["returned_by"] == 200


def test_partial_issue_has_appendix_acknowledgement_and_actual_return_count(monkeypatch):
    booking_id = ready_booking(monkeypatch,True)
    booking = get_booking(booking_id)
    assert len(booking.assets) == 1
    transition(booking_id,"ready",100)
    body,_ = customer_receipt_pdf(booking_id,42)
    document = Document(BytesIO(body))
    assert any("Приложение" in p.text for p in document.paragraphs)
    assert availability(booking.starts_at,booking.ends_at)[0]["available_quantity"] == 1
    paper(booking_id)
    transition(booking_id,"issued",100)
    with pytest.raises(Conflict): customer_attest(booking_id,42,"received",False)
    with pytest.raises(Conflict): customer_attest(booking_id,42,"received",True)
    returning(booking_id)
    transition(booking_id,"return_inspection",100)
    record_inspection(booking_id,booking.assets[0].equipment_id,"check_in","pass",{},"",100)
    paper(booking_id,point="return")
    assert transition(booking_id,"returned",100) == "returned"


def test_failed_docx_generation_rolls_back_ready_and_archive(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    from app import receipt_docx
    def fail(*args,**kwargs): raise RuntimeError("Synthetic renderer failure")
    monkeypatch.setattr(receipt_docx,"render_receipt_docx",fail)
    with pytest.raises(RuntimeError): transition(booking_id,"ready",100)
    assert get_booking(booking_id).status == "preparing"
    with Session() as session:
        assert session.get(BookingDocument,(booking_id,"receipt_docx")) is None
    assert not handover_state(booking_id).get("snapshot")


def test_change_deadlines_responses_are_encrypted_and_replay_safe(monkeypatch):
    configure(monkeypatch)
    from tests.test_operation_lease import pending_booking
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    proposal = {"start":(booking.starts_at+timedelta(days=1)).isoformat(),"end":(booking.ends_at+timedelta(days=1)).isoformat(),
                "lines":[{"article_id":row.article_id,"quantity":row.quantity} for row in booking.lines]}
    change_id = propose_change(booking_id,100,"manager_edit","Частный комментарий",proposal)
    assert get_booking(booking_id).status == "needs_changes"
    assert "comment" not in change_view(booking_id,200)
    assert change_view(booking_id,42)["comment"] == "Частный комментарий"
    with Session() as session:
        row = session.get(BookingChange,change_id)
        assert "Частный комментарий".encode() not in row.ciphertext
        deadline = row.deadline
    process_change_deadlines(deadline-timedelta(hours=2))
    process_change_deadlines(deadline-timedelta(hours=1))
    with Session() as session:
        assert len(session.scalars(select(NotificationDelivery).where(NotificationDelivery.booking_id==booking_id,NotificationDelivery.event=="request_change_reminder")).all()) == 1
    update_request(booking_id,42,None,None,None,change_id,True)
    assert get_booking(booking_id).starts_at.isoformat() == proposal["start"]
    with pytest.raises(Conflict): update_request(booking_id,42,None,None,None,change_id,True)
    second = propose_change(booking_id,100,"manager_edit","Ещё изменение",proposal)
    with Session() as session: deadline = session.get(BookingChange,second).deadline
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(process_change_deadlines,[deadline,deadline])) == 1
    assert get_booking(booking_id).status == "pending"
    assert change_view(booking_id,42)["status"] == "unanswered"


def test_manager_proposal_checks_stock_and_customer_response_rechecks_it(monkeypatch):
    configure(monkeypatch)
    from tests.test_operation_lease import pending_booking
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    camera = article_with_assets("CHANGE-CAMERA", 1)
    proposal = {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(),
                "lines": [{"article_id": row.article_id, "quantity": row.quantity} for row in booking.lines]
                         + [{"article_id": camera, "quantity": 2}]}
    with pytest.raises(Conflict, match="Недостаточно свободных единиц"):
        propose_change(booking_id, 100, "manager_edit", "Добавить камеру", proposal)
    assert get_booking(booking_id).status == "pending"
    proposal["lines"][-1]["quantity"] = 1
    change_id = propose_change(booking_id, 100, "manager_edit", "Добавить камеру", proposal)
    other = create_booking(43, "Клиент", "@synthetic", booking.starts_at, booking.ends_at,
                           [{"article_id": camera, "quantity": 1}])
    transition(other, "confirmed", 100)
    with pytest.raises(Conflict, match="Недостаточно свободных единиц"):
        update_request(booking_id, 42, None, None, None, change_id, True)
    assert change_view(booking_id, 42)["status"] == "pending"


def test_customer_accepts_one_available_camera_added_by_manager(monkeypatch):
    configure(monkeypatch)
    from tests.test_operation_lease import pending_booking
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    camera = article_with_assets("CHANGE-ONE-CAMERA", 1)
    proposal = {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(),
                "lines": [{"article_id": row.article_id, "quantity": row.quantity} for row in booking.lines]
                         + [{"article_id": camera, "quantity": 1}]}
    change_id = propose_change(booking_id, 100, "manager_edit", "Добавить камеру", proposal)
    update_request(booking_id, 42, None, None, None, change_id, True)
    assert any(row.article_id == camera and row.quantity == 1 for row in get_booking(booking_id).lines)
    assert change_view(booking_id, 42)["status"] == "accepted"


def test_customer_accepts_manager_edit_after_start_and_staff_can_issue(monkeypatch):
    from app import booking_changes, rental
    from app.miniapp_server import app
    from tests.test_operation_lease import pending_booking

    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    camera = article_with_assets("LATE-ACCEPT-CAMERA", 1)
    lines = [{"article_id": camera, "quantity": 1}]
    monkeypatch.setattr(booking_changes, "now", lambda: booking.starts_at - timedelta(hours=1))
    change_id = propose_change(booking_id, 100, "manager_edit", "Заменить камеру", {
        "start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(), "lines": lines,
    })
    after_start = booking.starts_at + timedelta(minutes=30)
    monkeypatch.setattr(booking_changes, "now", lambda: after_start)
    monkeypatch.setattr(rental, "now", lambda: after_start)

    response = TestClient(app).post(
        f"/api/miniapp/bookings/{booking_id}/changes/respond",
        headers={"X-Telegram-Init-Data": signed_init_data(42)},
        json={"change_id": change_id, "accept": True},
    )
    assert response.status_code == 200, response.text
    assert change_view(booking_id, 42)["status"] == "accepted"
    updated = get_booking(booking_id)
    assert (updated.starts_at, updated.ends_at) == (booking.starts_at, booking.ends_at)
    assert [row.article_id for row in updated.lines] == [camera]
    with pytest.raises(ValueError, match="Начало аренды уже прошло"):
        create_booking(42, "Клиент", "@synthetic", booking.starts_at, booking.ends_at, lines)

    assert transition(booking_id, "confirmed", 100) == "confirmed"
    verified_identity(booking_id)
    assign_booking_assets(booking_id, 100)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id, asset.equipment_id, "pre_issue", "pass", {}, "", 100)
    assert transition(booking_id, "ready", 100) == "ready"
    paper(booking_id)
    assert transition(booking_id, "issued", 100) == "issued"
    with pytest.raises(Conflict):
        update_request(booking_id, 42, None, None, None, change_id)


def test_operator_force_edit_supersedes_pending_proposal_and_is_audited(monkeypatch):
    from app import rental
    from app.db import BookingEvent, StaffRole
    from app.miniapp_server import app
    from tests.test_operation_lease import pending_booking

    configure(monkeypatch)
    with Session.begin() as session:
        session.get(StaffRole, 200).role = "operator"
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    article = article_with_assets("FORCE-EDIT", 2)
    proposal = {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(),
                "lines": [{"article_id": article, "quantity": 1}]}
    change_id = propose_change(booking_id, 100, "manager_edit", "Первая правка", proposal)
    monkeypatch.setattr(rental, "now", lambda: booking.starts_at + timedelta(minutes=30))
    client = TestClient(app)
    url = f"/api/miniapp/admin/bookings/{booking_id}/force-edit"
    staff = {"X-Telegram-Init-Data": signed_init_data(200)}
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    draft = client.get(url, headers=staff).json()
    assert draft["draft"]["lines"][0]["article_id"] == article
    payload = {**proposal, "lines": [{"article_id": article, "quantity": 2}],
               "revision": draft["revision"], "comment": "Обе камеры нужны"}
    assert client.put(url, headers=customer, json=payload).status_code == 403
    stock = client.get(url + "/availability", headers=staff, params={"start": proposal["start"], "end": proposal["end"]})
    assert stock.status_code == 200, stock.text
    assert next(row for row in stock.json()["items"] if row["id"] == article)["available_quantity"] == 2
    unavailable = {**payload, "lines": [{"article_id": article, "quantity": 3}]}
    assert client.put(url, headers=staff, json=unavailable).status_code == 409
    assert change_view(booking_id, 42)["status"] == "pending"

    saved = client.put(url, headers=staff, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["status"] == "pending"
    response_url = f"/api/miniapp/bookings/{booking_id}/changes/respond"
    assert client.post(response_url, headers=customer, json={"change_id": change_id, "accept": True}).status_code == 409
    assert client.put(url, headers=staff, json=payload).status_code == 409
    with Session() as session:
        assert session.get(BookingChange, change_id).status == "superseded"
        event = session.scalar(select(BookingEvent).where(BookingEvent.booking_id == booking_id)
                               .order_by(BookingEvent.version.desc()).limit(1))
        assert event.actor_id == 200 and event.actions == ["request_force_edited"]
        notification = session.scalar(select(NotificationDelivery).where(
            NotificationDelivery.event_id == event.id, NotificationDelivery.recipient_id == 42,
            NotificationDelivery.delivery_kind == "push"))
        assert "Подтверждение от клиента не требуется" in notification.message
        assert payload["comment"] not in notification.message
    change = change_view(booking_id, 42)
    assert change["change_type"] == "staff_edit" and change["comment"] == payload["comment"]
    assert [(row.article_id, row.quantity) for row in get_booking(booking_id).lines] == [(article, 2)]
    assert change["deadline"] is None
    assert transition(booking_id, "confirmed", 200) == "confirmed"


def test_operator_adds_position_after_start_on_ready_booking_and_reissues_draft(monkeypatch):
    from app import rental
    from app.miniapp_server import app

    booking_id = ready_booking(monkeypatch)
    transition(booking_id, "ready", 100)
    booking = get_booking(booking_id)
    assert handover_state(booking_id)["snapshot"]
    extra = article_with_assets("ADD-AFTER-START", 1)
    monkeypatch.setattr(rental, "now", lambda: booking.starts_at + timedelta(minutes=30))
    client = TestClient(app)
    staff = {"X-Telegram-Init-Data": signed_init_data(100)}
    url = f"/api/miniapp/admin/bookings/{booking_id}/force-edit"
    draft = client.get(url, headers=staff).json()
    dates = {key: draft["draft"][key] for key in ("start", "end")}
    listing = client.get(url + "/availability", headers=staff, params=dates)
    assert listing.status_code == 200, listing.text
    assert next(row for row in listing.json()["items"] if row["id"] == extra)["available_quantity"] == 1
    lines = [{"article_id": line.article_id, "quantity": line.quantity} for line in booking.lines]
    payload = {**dates, "lines": lines + [{"article_id": extra, "quantity": 1}],
               "revision": draft["revision"], "comment": "Добавлена камера"}
    response = client.put(url, json=payload, headers=staff)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "pending"
    edited = get_booking(booking_id)
    assert not edited.assets and not edited.inspections
    assert not handover_state(booking_id).get("snapshot")
    assert extra in {line.article_id for line in edited.lines}
    assert edited.identity_status == "verified"
    with pytest.raises(Conflict):
        assign_booking_assets(booking_id, 100)
    assert transition(booking_id, "confirmed", 100) == "confirmed"
    assign_booking_assets(booking_id, 100)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id, asset.equipment_id, "pre_issue", "pass", {}, "", 100)
    transition(booking_id, "ready", 100)
    new_asset = next(asset.equipment_id for asset in get_booking(booking_id).assets if asset.equipment.article_id == extra)
    assert new_asset in {row["id"] for row in handover_state(booking_id)["snapshot"]}
    prior_to_issue = client.get(url, headers=staff).json()["revision"]
    assert transition(booking_id, "issued", 100) == "issued"
    assert client.put(url, headers=staff, json={**payload, "revision": prior_to_issue}).status_code == 409


def test_customer_can_list_and_add_position_to_pending_booking_after_start(monkeypatch):
    from app import rental
    from app.miniapp_server import app
    from tests.test_operation_lease import pending_booking

    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    camera = article_with_assets("CUSTOMER-LATE-ADD", 1)
    monkeypatch.setattr(rental, "now", lambda: booking.starts_at + timedelta(minutes=30))
    url = f"/api/miniapp/bookings/{booking_id}"
    dates = {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat()}
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    client = TestClient(app)
    response = client.get(url + "/edit-availability", headers=headers, params=dates)
    assert response.status_code == 200, response.text
    assert camera in {item["id"] for item in response.json()["items"] if item["available"]}
    lines = [{"article_id": line.article_id, "quantity": line.quantity} for line in booking.lines]
    lines.append({"article_id": camera, "quantity": 1})
    response = client.put(url, headers=headers, json={**dates, "lines": lines})
    assert response.status_code == 200, response.text
    assert camera in {item["id"] for item in response.json()["items"]}


def test_inventory_permissions_owner_visibility_and_findings(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    asset = get_booking(booking_id).assets[0].equipment_id
    with pytest.raises(PermissionError): save_owner(asset,"Владелец","contact",200)
    save_owner(asset,"Медиацентр Полимер","test@example.test",100)
    assert "owner" not in inventory_details(asset,customer=True)
    save_owner(asset,"Другой владелец","test@example.test",100)
    assert inventory_details(asset,customer=True)["owner"] == "Другой владелец"
    assert "owner_contact" not in inventory_details(asset,customer=True)
    feature = save_feature(asset,"Особенность",200)
    with pytest.raises(PermissionError): save_feature(asset,"Правка",200,feature)
    transition(booking_id,"ready",100); paper(booking_id); transition(booking_id,"issued",100)
    returning(booking_id); transition(booking_id,"return_inspection",100)
    record_return_finding(booking_id,asset,100,"existing","Старая отметка")
    record_return_finding(booking_id,asset,100,"damage","Новая вмятина")
    assert len(handover_state(booking_id)["findings"]) == 2
    with Session() as session:
        assert session.scalar(select(EquipmentFeature.id).where(EquipmentFeature.source=="found_on_return"))
        assert session.scalar(select(NotificationDelivery.id).where(NotificationDelivery.booking_id==booking_id,NotificationDelivery.event=="owner_contact_required"))


def test_direct_api_rejects_foreign_attestations_and_untrusted_signers(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    transition(booking_id,"ready",100)
    from app.miniapp_server import app
    headers = lambda user:{"X-Telegram-Init-Data":signed_init_data(user)}
    with TestClient(app) as client:
        assert client.post(f"/api/miniapp/bookings/{booking_id}/attest",headers=headers(43),json={"action":"received"}).status_code == 422
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/paper-signature",headers=headers(200),json={"point":"issue","identity_matches":True,"paper_signed":True}).status_code == 403
        assert client.get(f"/api/miniapp/admin/bookings/{booking_id}/documents/receipt",headers=headers(100)).status_code == 403


def test_component_exceptions_do_not_remove_physical_asset_and_skip_return_checks(monkeypatch):
    booking_id=ready_booking(monkeypatch)
    from app.db import Article
    booking=get_booking(booking_id); line=booking.lines[0]; equipment=booking.assets[0].equipment_id
    with Session.begin() as session:
        session.get(Article,line.article_id).composition="Корпус\nАккумулятор\nКабель"
    exceptions=[{"line_id":line.id,"equipment_id":equipment,"component":"Кабель","reason":"missing","note":"Нет на складе"}]
    assignments={str(line.id):[asset.equipment_id for asset in booking.assets]}
    assign_booking_assets(booking_id,100,assignments,exceptions=exceptions)
    for asset in get_booking(booking_id).assets:
        with pytest.raises(Conflict,match="каждый выданный элемент"):
            record_inspection(booking_id,asset.equipment_id,"pre_issue","pass",{},"",100)
        checks={"component:0":True,"component:1":True}
        if asset.equipment_id!=equipment: checks["component:2"]=True
        record_inspection(booking_id,asset.equipment_id,"pre_issue","pass",checks,"",100)
    transition(booking_id,"ready",100)
    assert len(get_booking(booking_id).assets)==2
    snapshot=next(item for item in handover_state(booking_id)["snapshot"] if item["id"]==equipment)
    assert snapshot["components"][2]["state"]=="missing"
    paper(booking_id);transition(booking_id,"issued",100);returning(booking_id)
    record_inspection(booking_id,equipment,"check_in","pass",{"component:0":True,"component:1":True},"",100)


def test_other_trusted_staff_can_sign_without_taking_the_assignee(monkeypatch):
    booking_id=ready_booking(monkeypatch);transition(booking_id,"ready",100)
    from app.handover import set_trusted_signer
    set_trusted_signer(100,200,"Другой Доверенный",True)
    attest_paper_signature(booking_id,200,"issue",True,True)
    assert get_booking(booking_id).assignee_id==100
    transition(booking_id,"issued",100)
    state=handover_state(booking_id)
    assert state["issued_by"]==100 and state["issue_signature"]["actor_id"]==200


def test_replacement_capacity_is_checked_against_unassigned_confirmed_requests(monkeypatch):
    booking_id=ready_booking(monkeypatch);booking=get_booking(booking_id)
    other=article_with_assets("REPLACEMENT",1)
    occupied=create_booking(43,"Другой","@other",booking.starts_at,booking.ends_at,[{"article_id":other,"quantity":1}])
    transition(occupied,"confirmed",100)
    with Session() as session:
        from app.db import Equipment
        replacement=session.scalar(select(Equipment.id).where(Equipment.article_id==other))
    before={asset.equipment_id for asset in booking.assets}
    with pytest.raises(Conflict,match="уже занято"):
        assign_booking_assets(booking_id,100,{str(booking.lines[0].id):[booking.assets[0].equipment_id,replacement]},
            exceptions=[{"line_id":booking.lines[0].id,"reason":"replacement","replacement_id":replacement}])
    assert {asset.equipment_id for asset in get_booking(booking_id).assets}==before


def test_receipt_layout_with_features_components_and_appendix(monkeypatch):
    from app.receipt_pdf import render_receipt_pdf
    from types import SimpleNamespace
    import os
    from pathlib import Path
    configure(monkeypatch)
    booking=SimpleNamespace(id=7,human_number="ТС260007",identity_status="verified",assets=[object()],
        starts_at=now()+timedelta(days=5),ends_at=now()+timedelta(days=6),customer_contact="@synthetic")
    snapshot=[{"id":21,"name":"Камера Sony FX3","code":"TEST-CAM-001",
        "features":[{"description":"Небольшая царапина на нижней крышке"}],
        "components":[{"name":"Корпус","state":"issued"},{"name":"Аккумулятор","state":"replacement","replacement_name":"Аккумулятор Sony NP-FZ100"},{"name":"Кабель","state":"missing"}]}]
    body=render_receipt_pdf(7,200,booking=booking,identity={"full_name":"Тестовый Получатель","passport_series":"0000","passport_number":"123456",
        "passport_issuer":"Тестовый отдел","passport_issued_at":"2020-01-01","registration_address":"Тестовая улица, 1","residential_address":"Тестовая улица, 1"},
        snapshot=snapshot,exceptions=[{"name":"Камера Sony FX3","component":"Кабель","reason":"missing","note":"Не поступил на склад"}])
    reader=PdfReader(BytesIO(body));assert len(reader.pages)==2
    assert "Комплектация" in reader.pages[0].extract_text() and "Царапина".lower() in reader.pages[0].extract_text().lower()
    if os.getenv("PDF_QA_DIRECTORY"):
        folder=Path(os.environ["PDF_QA_DIRECTORY"]);folder.mkdir(parents=True,exist_ok=True);(folder/"receipt-qa.pdf").write_bytes(body)


def test_ready_pdf_is_draft_until_issue_and_changed_features_require_new_ack(monkeypatch):
    booking_id=ready_booking(monkeypatch);transition(booking_id,"ready",100)
    with Session() as session: assert session.get(ReceiptArchive,booking_id) is None
    body=customer_receipt_pdf(booking_id,42)[0]
    paper(booking_id)
    asset=get_booking(booking_id).assets[0].equipment_id
    save_feature(asset,"Особенность найдена до выдачи",100)
    with pytest.raises(Conflict,match="изменились"):transition(booking_id,"issued",100)
    return_for_rework(booking_id,"preparing","Повторить подготовку",100)
    with Session() as session: assert session.get(BookingDocument,(booking_id,"receipt_docx")) is None
    transition(booking_id,"ready",100)
    assert not handover_state(booking_id).get("received_at")
    assert customer_receipt_pdf(booking_id,42)[0]!=body
    paper(booking_id);transition(booking_id,"issued",100)
    with Session() as session: assert session.get(ReceiptArchive,booking_id) is not None


def test_pii_only_reviewer_cannot_use_staff_operations(monkeypatch):
    configure(monkeypatch);monkeypatch.setenv("ADMIN_IDS","100")
    from tests.test_operation_lease import pending_booking
    booking_id=pending_booking()
    from app.miniapp_server import app
    headers={"X-Telegram-Init-Data":signed_init_data(200)}
    with TestClient(app) as client:
        role=client.get("/api/miniapp/me",headers=headers).json()
        assert role["pii_only"] and "staff_role" not in role
        assert client.get("/api/miniapp/admin/bookings",headers=headers).status_code==200
        assert client.get("/api/miniapp/admin/catalog",headers=headers).status_code==403
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/transition",headers=headers,json={"action":"confirmed"}).status_code==403


def test_private_rework_comment_is_scoped_and_purged_with_identity(monkeypatch):
    configure(monkeypatch)
    from tests.test_operation_lease import pending_booking
    from app.rental import rework_reason,booking_history
    from app.pii import delete_identity
    booking_id=pending_booking();transition(booking_id,"confirmed",100);verified_identity(booking_id)
    return_for_rework(booking_id,"pending","Частная причина",100)
    assert rework_reason(booking_id,42)["comment"]=="Частная причина"
    with pytest.raises(PermissionError):rework_reason(booking_id,43)
    assert "Частная причина" not in str(booking_history(booking_id))
    delete_identity(booking_id,200)
    assert "удалён" in rework_reason(booking_id,42)["comment"]


def test_legacy_issue_migration_preserves_historical_act_and_unknown_snapshot(monkeypatch):
    booking_id=ready_booking(monkeypatch)
    import hashlib,os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from app.pii import _master_key
    from app.handover import migrate_legacy_receipt
    from app.documents import operator_document
    nonce=os.urandom(12);original=b"historical-act-bytes"
    with Session.begin() as session:
        booking=session.get(Booking,booking_id);booking.status="issued";booking.act_signed_at=now();booking.act_signed_by=200
        session.add(BookingDocument(booking_id=booking_id,kind="issue",filename="legacy-act.docx",media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            encrypted_data=AESGCM(_master_key()).encrypt(nonce,original,f"{booking_id}:issue:doc-v1".encode()),nonce=nonce,sha256=hashlib.sha256(original).hexdigest()))
    migrate_legacy_receipt(booking_id,200)
    state=handover_state(booking_id)
    assert state["legacy_snapshot_unknown"] and "issue_signature" not in state
    assert all(not item["features"] for item in state["snapshot"])
    assert operator_document(booking_id,"issue",200)[0]==original
    assert customer_receipt_pdf(booking_id,42)[0].startswith(b"PK")
    returning(booking_id)
    for asset in get_booking(booking_id).assets:record_inspection(booking_id,asset.equipment_id,"check_in","pass",{},"",100)
    paper(booking_id,point="return");transition(booking_id,"returned",100)
    assert operator_document(booking_id,"issue",200)[0]==original
