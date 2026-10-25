"""Regression coverage for the full rental workflow found during the audit."""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import Booking, Equipment, PrivacyConsent, Session
from app.rental import (Conflict, assign_booking_assets, availability, create_booking,
                        get_booking, record_inspection, save_article, save_equipment,
                        transition)
from tests.test_integration import article_with_assets


def prepared_booking(prefix="QA", count=2):
    article_id = article_with_assets(prefix, count)
    start, end = now_interval()
    booking_id = create_booking(42, "Тестовый клиент", "@qa", start, end,
                                [{"article_id": article_id, "quantity": 1}])
    transition(booking_id, "confirmed", 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    assign_booking_assets(booking_id, 100)
    return booking_id, article_id


def now_interval():
    from app.rental import now
    return now() + timedelta(hours=3), now() + timedelta(hours=5)


def test_reassignment_invalidates_old_inspection():
    booking_id, article_id = prepared_booking()
    old = get_booking(booking_id)
    record_inspection(booking_id, old.assets[0].equipment_id, "pre_issue", "pass", {}, "", 100)
    with Session() as session:
        replacement = session.scalar(select(Equipment.id).where(
            Equipment.article_id == article_id, Equipment.id != old.assets[0].equipment_id))
    assign_booking_assets(booking_id, 100, {str(old.lines[0].id): [replacement]})
    with pytest.raises(Conflict):
        transition(booking_id, "ready", 100)
    record_inspection(booking_id, replacement, "pre_issue", "pass", {}, "", 100)
    assert transition(booking_id, "ready", 100) == "ready"


@pytest.mark.parametrize("stage", ["pre_issue", "check_in"])
def test_inspections_cannot_change_after_cancellation(stage):
    booking_id, _ = prepared_booking()
    asset_id = get_booking(booking_id).assets[0].equipment_id
    transition(booking_id, "cancelled", 100)
    with pytest.raises(ValueError):
        record_inspection(booking_id, asset_id, stage, "fail", {}, "", 100)
    with Session() as session:
        assert session.get(Equipment, asset_id).condition == "available"


def test_customer_cannot_advance_order_through_transition():
    booking_id, _ = prepared_booking()
    with pytest.raises(Conflict):
        transition(booking_id, "preparing", 42, customer_id=42)


def test_assigned_asset_cannot_move_to_another_article():
    booking_id, _ = prepared_booking()
    asset = get_booking(booking_id).assets[0].equipment
    other_id = save_article("OTHER", "Другая модель", "", 100)
    with pytest.raises(Conflict):
        save_equipment(asset.inventory_number, "", "", 0, "available", asset.id,
                       article_id=other_id)


@pytest.mark.parametrize("field", ["sku", "name"])
def test_article_rejects_whitespace(field):
    values = {"sku": "QA-ARTICLE", "name": "Модель", "description": "", "rate": 100}
    values[field] = "   "
    with pytest.raises(ValueError):
        save_article(**values)


def test_quantity_limit_cannot_be_bypassed_with_duplicate_lines():
    article_id = article_with_assets("MANY", 31)
    start, end = now_interval()
    with pytest.raises(ValueError):
        create_booking(42, "Тест", "@qa", start, end,
                       [{"article_id": article_id, "quantity": 30},
                        {"article_id": article_id, "quantity": 1}])


def test_nonoverlapping_bookings_do_not_add_up_to_false_unavailability():
    from app.rental import now
    article_id = article_with_assets("SEQUENTIAL", 2)
    with Session.begin() as session:
        from app.db import Article
        session.get(Article, article_id).buffer_hours = 0
    start = now() + timedelta(days=2)
    for offset in (1, 3):
        create_booking(42, "Тест", "@qa", start + timedelta(hours=offset),
                       start + timedelta(hours=offset + 1),
                       [{"article_id": article_id, "quantity": 1}])
    assert availability(start, start + timedelta(hours=6))[0]["available_quantity"] == 1


def test_concurrent_retries_return_same_booking():
    from concurrent.futures import ThreadPoolExecutor
    from uuid import uuid4
    article_id = article_with_assets("RETRY", 1)
    start, end = now_interval()
    request_id = str(uuid4())
    def book():
        return create_booking(42, "Тест", "@qa", start, end,
                              [{"article_id": article_id, "quantity": 1}], request_id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: book(), range(2)))
    assert results[0] == results[1]


def test_customer_cannot_cancel_during_preparation():
    booking_id, _ = prepared_booking()
    with pytest.raises(Conflict):
        transition(booking_id, "cancelled", 42, customer_id=42)


def test_calendar_keeps_preparing_and_ready_orders(monkeypatch):
    from fastapi.testclient import TestClient
    from app.miniapp_server import app
    booking_id, _ = prepared_booking()
    monkeypatch.setenv("ICAL_TOKEN", "qa-calendar")
    client = TestClient(app)
    for status in ("preparing", "ready", "issued", "return_inspection"):
        with Session.begin() as session:
            session.get(Booking, booking_id).status = status
        response = client.get("/calendar/qa-calendar.ics")
        assert response.status_code == 200
        assert f"booking-{booking_id}@polyrental" in response.text
        assert response.headers["cache-control"] == "no-store"
    assert client.get("/calendar/wrong.ics").status_code == 404


@pytest.fixture
def identity_case(monkeypatch):
    from fastapi.testclient import TestClient
    from app import miniapp
    from app.miniapp_server import app
    from app.pii import submit_identity, consent_text
    from tests.test_miniapp import configure, signed_init_data, image_bytes
    import hashlib
    configure(monkeypatch)
    async def quiet(*args):
        pass
    for name in ("notify_new_booking", "notify_booking_status", "notify_cancelled_booking"):
        monkeypatch.setattr(miniapp, name, quiet)
    client = TestClient(app)
    from tests.test_miniapp import create_confirmed
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    booking_id = create_confirmed(client, headers)
    fields = {"full_name": "Тестовый Клиент", "birth_date": "2000-01-01",
              "passport_series": "0000", "passport_number": "000000",
              "passport_issued_at": "2020-01-01", "passport_issuer": "Тест",
              "passport_division_code": "000-000", "registration_address": "Тест",
              "residential_address": "Тест", "student_id_number": "TEST", "student_institution": "Тест"}
    text_hash = hashlib.sha256(consent_text().encode()).hexdigest()
    documents = {kind: (image_bytes(), "image/png") for kind in
                 ("passport_main", "passport_registration", "student_front")}
    submit_identity(booking_id, 42, fields, documents, "test-v1", text_hash)
    return client, booking_id, fields, documents, text_hash


def test_identity_corrections_keep_original_consent(identity_case):
    from app.pii import submit_identity, review_identity
    _, booking_id, fields, _, text_hash = identity_case
    review_identity(booking_id, 200, False, "Исправить адрес", ["residential_address"])
    with Session() as session:
        consented_at = session.scalar(select(PrivacyConsent).where(
            PrivacyConsent.booking_id == booking_id)).consented_at
    submit_identity(booking_id, 42, {**fields, "residential_address": "Исправленный адрес"}, {}, "", "")
    with Session() as session:
        consent = session.scalar(select(PrivacyConsent).where(PrivacyConsent.booking_id == booking_id))
        assert (consent.policy_version, consent.text_hash, consent.consented_at) == ("test-v1", text_hash, consented_at)


def test_blocked_identity_cannot_be_resubmitted_or_approved(identity_case):
    from app.pii import submit_identity, review_identity, block_identity
    _, booking_id, fields, documents, text_hash = identity_case
    block_identity(booking_id, 200)
    with pytest.raises(Conflict):
        submit_identity(booking_id, 42, fields, documents, "test-v1", text_hash)
    with pytest.raises(ValueError):
        review_identity(booking_id, 200, True)


def test_api_roles_owner_isolation_and_private_cache(identity_case):
    from tests.test_miniapp import signed_init_data
    client, booking_id, *_ = identity_case
    def headers(user):
        return {"X-Telegram-Init-Data": signed_init_data(user)}
    assert client.get("/api/miniapp/admin/catalog").status_code == 401
    assert client.get("/api/miniapp/admin/catalog", headers=headers(42)).status_code == 403
    assert client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=headers(100)).status_code == 403
    assert client.get(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers(43)).status_code == 404
    assert client.post(f"/api/miniapp/bookings/{booking_id}/cancel", headers=headers(43)).status_code == 404
    response = client.get(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers(42))
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert client.get("/api/miniapp/bookings", headers=headers(43)).json() == {"items": []}


def test_requested_photo_correction_cannot_reuse_old_photo(identity_case):
    from app.pii import submit_identity, review_identity
    _, booking_id, fields, _, _ = identity_case
    review_identity(booking_id, 200, False, "Заменить фото", ["passport_main"])
    with pytest.raises(ValueError, match="фотографии"):
        submit_identity(booking_id, 42, fields, {}, "", "")


@pytest.mark.parametrize("rate", ["NaN", "Infinity", "abc", "-1", "1.001", "10000000000"])
def test_invalid_rate_is_a_validation_error(rate):
    with pytest.raises(ValueError):
        save_equipment("INVALID", "Тест", "", rate, "available")


def test_document_rotation_is_applied_before_removing_exif():
    import io
    from PIL import Image
    from app.pii import sanitize_image
    source = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (10, 20), "white").save(source, format="JPEG", exif=exif)
    data, _ = sanitize_image(source.getvalue(), "image/jpeg")
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (20, 10)
        assert not image.getexif()


def test_overdue_unreturned_asset_cannot_be_booked_again():
    from app.rental import now
    booking_id, article_id = prepared_booking(count=1)
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.starts_at = now() - timedelta(days=2)
        booking.ends_at = now() - timedelta(days=1)
        booking.status = "issued"
    start, end = now_interval()
    assert availability(start, end)[0]["available_quantity"] == 0
    with pytest.raises(Conflict):
        create_booking(43, "Другой клиент", "@qa", start, end,
                       [{"article_id": article_id, "quantity": 1}])


def test_repair_close_does_not_revive_retired_equipment():
    from app.db import RepairTicket
    from app.rental import close_repair
    booking_id, _ = prepared_booking()
    asset_id = get_booking(booking_id).assets[0].equipment_id
    record_inspection(booking_id, asset_id, "pre_issue", "fail", {}, "Дефект", 100)
    with Session.begin() as session:
        session.get(Equipment, asset_id).condition = "retired"
        ticket_id = session.scalar(select(RepairTicket.id).where(RepairTicket.booking_id == booking_id))
    close_repair(ticket_id, 100)
    with Session() as session:
        assert session.get(Equipment, asset_id).condition == "retired"


def test_review_rejection_invalidates_act_signature(identity_case):
    from app.pii import review_identity
    from app.rental import mark_act_signed
    _, booking_id, *_ = identity_case
    review_identity(booking_id, 200, True)
    assign_booking_assets(booking_id, 100)
    asset_id = get_booking(booking_id).assets[0].equipment_id
    record_inspection(booking_id, asset_id, "pre_issue", "pass", {}, "", 100)
    transition(booking_id, "ready", 100)
    mark_act_signed(booking_id, 200)
    review_identity(booking_id, 200, False, "Исправить адрес", ["residential_address"])
    assert get_booking(booking_id).act_signed_at is None


def test_admin_catalog_crud_and_validation(monkeypatch):
    from fastapi.testclient import TestClient
    from app.miniapp_server import app
    from tests.test_miniapp import configure, signed_init_data
    configure(monkeypatch)
    client = TestClient(app)
    headers = {"X-Telegram-Init-Data": signed_init_data(100)}
    article = {"sku":"QA-SKU", "name":"Камера", "rate":"12.50"}
    response = client.post("/api/miniapp/admin/catalog/articles", json=article, headers=headers)
    assert response.status_code == 200
    article_id = response.json()["id"]
    duplicate = client.post("/api/miniapp/admin/catalog/articles", json=article, headers=headers)
    assert duplicate.status_code == 422 and "уже существует" in duplicate.json()["detail"]
    assert "INSERT" not in duplicate.text
    for invalid in ({"name":"   "}, {"rate":"1.001"}, {"rate":"10000000000"}, {"image_url":"javascript:alert(1)"}):
        assert client.post("/api/miniapp/admin/catalog/articles", json={**article, **invalid}, headers=headers).status_code == 422
    asset = {"article_id":article_id, "serial":"QA-SERIAL", "location":"A-01"}
    response = client.post("/api/miniapp/admin/catalog/equipment", json=asset, headers=headers)
    assert response.status_code == 200
    asset_id = response.json()["id"]
    assert client.post("/api/miniapp/admin/catalog/equipment", json=asset, headers=headers).status_code == 422
    assert client.post("/api/miniapp/admin/catalog/equipment", json={**asset, "id":asset_id, "condition":"retired"}, headers=headers).status_code == 200
    catalog = client.get("/api/miniapp/admin/catalog", headers=headers).json()
    assert catalog["articles"][0]["equipment"][0]["condition"] == "retired"
    start, end = now_interval()
    public = client.get("/api/miniapp/availability", params={"start":start.isoformat(), "end":end.isoformat()}).json()
    assert public["items"] == [] and public["unavailable_count"] == 1
    assert "QA-SERIAL" not in json_text(public)


def json_text(value):
    import json
    return json.dumps(value, ensure_ascii=False)


def test_all_admin_api_routes_require_staff(monkeypatch):
    from fastapi.testclient import TestClient
    from app.miniapp_server import app
    from tests.test_miniapp import configure, signed_init_data
    configure(monkeypatch)
    client = TestClient(app)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    checked = 0
    for route in app.routes:
        if not getattr(route, "path", "").startswith("/api/miniapp/admin/"):
            continue
        path = route.path
        for name in ("booking_id", "parent_id", "child_id", "ticket_id"):
            path = path.replace("{" + name + "}", "1")
        path = path.replace("{kind}", "passport_main")
        method = next(iter(route.methods - {"HEAD", "OPTIONS"}))
        assert client.request(method, path, json={}).status_code == 401, path
        assert client.request(method, path, headers=headers, json={}).status_code == 403, path
        checked += 1
    assert checked >= 15


def test_parallel_http_retry_only_notifies_once(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import AsyncMock
    from uuid import uuid4
    from fastapi.testclient import TestClient
    from app import miniapp
    from app.miniapp_server import app
    from tests.test_miniapp import configure, signed_init_data
    configure(monkeypatch)
    notification = AsyncMock()
    monkeypatch.setattr(miniapp, "notify_new_booking", notification)
    article_id = article_with_assets("HTTP-RETRY", 1)
    start, end = now_interval()
    payload = {"request_id":str(uuid4()), "name":"Тест", "contact":"@qa",
               "start":start.isoformat(), "end":end.isoformat(), "expected_total":"200.00",
               "lines":[{"article_id":article_id, "quantity":1}]}
    client = TestClient(app)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post("/api/miniapp/bookings", json=payload, headers=headers), range(2)))
    assert all(response.status_code == 201 for response in results)
    assert results[0].json()["id"] == results[1].json()["id"]
    assert notification.await_count == 1
