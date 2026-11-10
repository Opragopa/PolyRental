"""Regression scenarios for transactional updates, categories and round-the-clock work."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.methods import EditMessageText, SendMessage
from docx import Document
from fastapi.testclient import TestClient
from sqlalchemy import select, func

from app.booking_events import claim_notices
from app.catalog_categories import create_category, list_categories
from app.catalog_import import import_catalog_csv
from app.db import (Audit, Booking, BookingBotCard, BookingEvent, BookingEventRecipient,
                    CatalogCategory, NotificationDelivery, Session, StaffRole)
from app.miniapp_server import app
from app.notification_outbox import deliver_notification
from app.rental import (get_booking, reassign_booking, return_for_rework, save_article,
                        transition, update_booking_contact)
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def events(booking_id):
    with Session() as session:
        return session.scalars(select(BookingEvent).where(BookingEvent.booking_id == booking_id).order_by(BookingEvent.version)).all()


def deliveries(event_id, kind=None):
    with Session() as session:
        statement = select(NotificationDelivery).where(NotificationDelivery.event_id == event_id)
        if kind:
            statement = statement.where(NotificationDelivery.delivery_kind == kind)
        return session.scalars(statement).all()


def test_events_are_transactional_skip_reads_and_noops_and_use_original_assignee(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    created = events(booking_id)
    assert len(created) == 1
    assert {row.recipient_id for row in deliveries(created[0].id, "push")} == {100, 200}
    get_booking(booking_id)
    update_booking_contact(booking_id, 42, "Клиент", "@client")
    assert len(events(booking_id)) == 1
    with pytest.raises(RuntimeError):
        with Session.begin() as session:
            booking = session.get(Booking, booking_id)
            booking.status = "cancelled"
            session.add(Audit(booking_id=booking_id, actor_id=100, action="cancelled"))
            session.flush()
            raise RuntimeError("rollback")
    assert len(events(booking_id)) == 1
    assert get_booking(booking_id).status == "pending"
    transition(booking_id, "confirmed", 100)
    confirmed = events(booking_id)[-1]
    assert {row.recipient_id for row in deliveries(confirmed.id, "push")} == {42}
    assert {row.recipient_id for row in deliveries(confirmed.id, "card")} == {42, 100, 200}
    reassign_booking(booking_id, 100, 200)
    transferred = events(booking_id)[-1]
    assert {row.recipient_id for row in deliveries(transferred.id, "push")} == {42, 200}
    assert {row.recipient_id for row in deliveries(transferred.id, "card")} == {42, 100, 200}
    transition(booking_id, "cancelled", 200)
    assert {row.recipient_id for row in deliveries(events(booking_id)[-1].id, "push")} == {42}
    assert get_booking(booking_id).assignee_id is None
    assert all(row.event_id for row in deliveries(events(booking_id)[-1].id))


def test_notices_claimed_once_concurrently_and_repeated_status_is_new(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    assert claim_notices(42) == []  # author does not see a duplicate of their action
    transition(booking_id, "confirmed", 100)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: claim_notices(42), range(2)))
    assert sum(len(result) for result in results) == 1
    assert claim_notices(42) == []
    return_for_rework(booking_id, "pending", "Повторная проверка", 100)
    transition(booking_id, "confirmed", 100)
    updates = claim_notices(42)
    assert len(updates) == 2 and updates[-1]["status"] == "confirmed"
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(BookingEventRecipient).where(
            BookingEventRecipient.recipient_id == 42, BookingEventRecipient.shown_at.is_(None))) == 0


@pytest.mark.parametrize("role", ["operator", "manager", "admin"])
@pytest.mark.parametrize("moment", ["2026-10-29T23:00:00+03:00", "2026-11-01T12:00:00+03:00", "2026-11-04T12:00:00+03:00"])
def test_staff_can_confirm_and_cancel_at_any_time(monkeypatch, role, moment):
    configure(monkeypatch)
    booking_id = pending_booking()
    with Session.begin() as session:
        session.get(StaffRole, 200).role = role
    monkeypatch.setenv("ENFORCE_HANDOVER_SCHEDULE", "true")
    monkeypatch.setattr("app.schedule.current_time", lambda: datetime.fromisoformat(moment))
    assert transition(booking_id, "confirmed", 200) == "confirmed"
    assert transition(booking_id, "cancelled", 200) == "cancelled"
    from app.schedule import validate_planned_slot
    with pytest.raises(ValueError):
        validate_planned_slot(datetime.fromisoformat("2026-11-01T23:00:00+03:00"))


def test_operator_api_confirms_and_categories_are_shared_with_import(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    with Session.begin() as session:
        session.get(StaffRole, 200).role = "operator"
    headers = {"X-Telegram-Init-Data": signed_init_data(200)}
    # Keep this test offline; the outbox transport is tested separately below.
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    with TestClient(app) as client:
        response = client.post(f"/api/miniapp/admin/bookings/{booking_id}/transition", headers=headers, json={"action":"confirmed"})
        assert response.status_code == 200, response.text
        response = client.post("/api/miniapp/admin/catalog/categories", headers=headers, json={"name":"  Звук   и запись  "})
        assert response.status_code == 200, response.text
        category = response.json()
        assert category["name"] == "Звук и запись"
        assert category in client.get("/api/miniapp/catalog/categories").json()["items"]
        assert client.post("/api/miniapp/admin/catalog/categories", headers=headers, json={"name":"звук и ЗАПИСЬ"}).status_code == 422
        assert client.post("/api/miniapp/admin/catalog/categories", headers={"X-Telegram-Init-Data": signed_init_data(42)}, json={"name":"Denied"}).status_code == 403
        assert client.post("/api/miniapp/admin/catalog/categories", headers=headers, json={"name":"   "}).status_code == 422
    article_id = save_article("AUDIO-CUSTOM", "Рекордер Zoom H6", "", "0", category=category["code"], actor_id=200)
    assert article_id
    result = import_catalog_csv(f"sku,name,category,serial\nAUDIO-IMPORT,Zoom H4,{category['code']},TEST-SOUND\n".encode())
    assert result["articles_created"] == 1


def test_card_is_edited_recovered_and_older_delivery_cannot_revert_it(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    sent, edited = [], []

    class FakeBot:
        missing = False
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def send_message(self, recipient, text, **kwargs):
            assert kwargs["link_preview_options"].is_disabled is True
            sent.append((recipient, text))
            return SimpleNamespace(message_id=len(sent))
        async def edit_message_text(self, **kwargs):
            edited.append(kwargs)
            if self.missing:
                self.missing = False
                raise TelegramBadRequest(EditMessageText(text="x", chat_id=42, message_id=1), "message to edit not found")

    bot = FakeBot()
    monkeypatch.setattr("app.bot.make_bot", lambda _: bot)
    first = next(row for row in deliveries(events(booking_id)[0].id, "card") if row.recipient_id == 42)
    assert asyncio.run(deliver_notification(first.id))
    transition(booking_id, "confirmed", 100)
    second = next(row for row in deliveries(events(booking_id)[-1].id, "card") if row.recipient_id == 42)
    assert asyncio.run(deliver_notification(second.id))
    assert len(sent) == 1 and len(edited) == 1
    assert "Создана:" in sent[0][1] and "Кем:" in sent[0][1]
    assert edited[0]["link_preview_options"].is_disabled is True
    assert "подтверждена" in edited[0]["text"]
    assert asyncio.run(deliver_notification(first.id))
    assert len(edited) == 1
    bot.missing = True
    transition(booking_id, "cancelled", 100)
    last = next(row for row in deliveries(events(booking_id)[-1].id, "card") if row.recipient_id == 42)
    assert asyncio.run(deliver_notification(last.id))
    assert len(sent) == 2 and "отменена" in sent[-1][1]
    with Session() as session:
        assert session.get(BookingBotCard, (booking_id, 42)).message_id == 2


def test_forbidden_delivery_stops_retry_and_quiet_hours_delay_only_staff(monkeypatch):
    configure(monkeypatch)
    from app.operator_preferences import save_preferences
    save_preferences(200, "00:00", "23:59")
    booking_id = pending_booking()
    update = events(booking_id)[0]
    staff_push = next(row for row in deliveries(update.id, "push") if row.recipient_id == 200)
    assert staff_push.next_retry_at > datetime.now(timezone.utc)
    delivery = next(row for row in deliveries(update.id, "card") if row.recipient_id == 42)
    class FakeBot:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def send_message(self, *args, **kwargs):
            raise TelegramForbiddenError(SendMessage(chat_id=42, text="x"), "bot was blocked")
    monkeypatch.setattr("app.bot.make_bot", lambda _: FakeBot())
    assert not asyncio.run(deliver_notification(delivery.id))
    with Session() as session:
        row = session.get(NotificationDelivery, delivery.id)
        assert row.cancelled_at and row.next_retry_at is None and row.attempts == 1


def test_parallel_card_delivery_sends_once_and_uses_latest_version(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    earliest = next(row for row in deliveries(events(booking_id)[0].id, "card") if row.recipient_id == 42)
    transition(booking_id, "confirmed", 100)
    transition(booking_id, "cancelled", 100)
    latest_event = events(booking_id)[-1]
    latest = next(row for row in deliveries(latest_event.id, "card") if row.recipient_id == 42)
    sent = []
    class FakeBot:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def send_message(self, recipient, text, **kwargs):
            await asyncio.sleep(0.05)
            sent.append(text)
            return SimpleNamespace(message_id=77)
        async def edit_message_text(self, **kwargs):
            pytest.fail("A stale card must not overwrite the latest version")
    monkeypatch.setattr("app.bot.make_bot", lambda _: FakeBot())
    async def parallel_delivery():
        return await asyncio.gather(deliver_notification(earliest.id), deliver_notification(latest.id))
    results = asyncio.run(parallel_delivery())
    assert any(results)
    for result, row in zip(results, [earliest, latest]):
        if not result:
            assert asyncio.run(deliver_notification(row.id))
    assert len(sent) == 1 and "отменена" in sent[0]
    with Session() as session:
        assert session.get(BookingBotCard, (booking_id, 42)).event_id == latest_event.id


def test_booking_link_selects_only_the_owners_completed_request(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    transition(booking_id, "confirmed", 100)
    transition(booking_id, "cancelled", 100)
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    with TestClient(app) as client:
        path = f"/api/miniapp/profile/history?category=all&booking_id={booking_id}"
        headers = lambda user: {"X-Telegram-Init-Data":signed_init_data(user)}
        assert [row["id"] for row in client.get(path, headers=headers(42)).json()["items"]] == [booking_id]
        assert client.get(path, headers=headers(43)).json()["items"] == []


def test_docx_download_is_saved_and_uses_correct_type(monkeypatch):
    from tests.test_completion_workflows import ready_booking
    from app.receipt_archive import customer_receipt_pdf
    booking_id = ready_booking(monkeypatch, partial=True)
    transition(booking_id, "ready", 100)
    body, filename = customer_receipt_pdf(booking_id, 42)
    assert filename.endswith(".docx")
    doc = Document(BytesIO(body))
    all_text = "\n".join([p.text for p in doc.paragraphs] + [cell.text for table in doc.tables for row in table.rows for cell in row.cells])
    assert "Приложение к сохранной расписке" in all_text and "Не выдано" in all_text and "{{" not in all_text
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    with TestClient(app) as client:
        headers = {"X-Telegram-Init-Data": signed_init_data(42)}
        response = client.get(f"/api/miniapp/bookings/{booking_id}/receipt", headers=headers)
        assert response.content == body
        assert "wordprocessingml.document" in response.headers["content-type"]
        assert filename in response.headers["content-disposition"]
        assert client.get(f"/api/miniapp/bookings/{booking_id}/receipt", headers={"X-Telegram-Init-Data": signed_init_data(43)}).status_code == 404


@pytest.mark.parametrize("moment", ["2026-10-29T23:00:00+03:00", "2026-11-01T12:00:00+03:00", "2026-11-04T12:00:00+03:00"])
def test_full_handover_outside_working_hours(monkeypatch, moment):
    from tests.test_completion_workflows import ready_booking
    from tests.workflow_helpers import paper, returning
    from app.rental import record_inspection
    booking_id = ready_booking(monkeypatch)
    with Session.begin() as session:
        session.get(StaffRole, 100).role = "operator"
    monkeypatch.setattr("app.schedule.current_time", lambda: datetime.fromisoformat(moment))
    transition(booking_id, "ready", 100)
    paper(booking_id)
    assert transition(booking_id, "issued", 100) == "issued"
    returning(booking_id)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id, asset.equipment_id, "check_in", "pass", {}, "", 100)
    paper(booking_id, point="return")
    assert transition(booking_id, "returned", 100) == "returned"


def test_docx_template_multiple_items_special_characters_and_long_names(monkeypatch):
    import os
    from pathlib import Path
    from zipfile import ZipFile
    from app.receipt_docx import render_receipt_docx
    configure(monkeypatch)
    booking = SimpleNamespace(id=7, human_number="ТС260007", customer_contact="@synthetic")
    snapshot = [{"id": index, "name": "Камера Sony FX3 <Cinema> & объектив " + "с длинным названием " * 4,
        "code": f"TEST-{index:03d}", "features": [{"description": "Царапина на нижней крышке"}],
        "components": [{"name": "Корпус", "state": "issued"}, {"name": "Аккумулятор", "state": "replacement", "replacement_name": "Sony NP-FZ100"}]} for index in range(1, 4)]
    body = render_receipt_docx(booking, {"full_name":"Тестовый Получатель", "passport_series":"0000", "passport_number":"123456", "residential_address":"Тестовая улица, 1"}, snapshot,
        [{"name":"Камера Sony FX3", "component":"Кабель", "reason":"missing", "note":"Не поступил на склад"}])
    xml = ZipFile(BytesIO(body)).read("word/document.xml").decode()
    assert "ТС-ТС" not in xml and "{{" not in xml
    document = Document(BytesIO(body))
    assert "TEST-003" in "\n".join(cell.text for table in document.tables for row in table.rows for cell in row.cells)
    if os.getenv("DOCX_QA_DIRECTORY"):
        folder = Path(os.environ["DOCX_QA_DIRECTORY"])
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "receipt-qa.docx").write_bytes(body)


def test_fresh_migration_chain(monkeypatch):
    import os
    import subprocess
    import sys
    from uuid import uuid4
    from sqlalchemy import text
    from app.db import engine
    assert engine.url.database == "polyrental_test"
    schema = "booking_fix_migration_" + uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        env = {**os.environ, "DATABASE_URL":engine.url.render_as_string(hide_password=False) + f"?options=-csearch_path={schema}"}
        result = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], env=env, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        with engine.connect() as connection:
            assert connection.scalar(text(f'SELECT count(*) FROM "{schema}".catalog_categories')) == 14
            assert connection.scalar(text(f'SELECT version_num FROM "{schema}".alembic_version')) == "20261110_45"
            assert connection.scalar(text("SELECT count(*) FROM information_schema.columns WHERE table_schema=:schema AND table_name='client_profiles' AND column_name='display_name'"), {"schema": schema}) == 1
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
