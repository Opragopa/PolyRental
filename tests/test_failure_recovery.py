"""Regression coverage for failures that must not silently lose or lock work."""

import asyncio

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import NotificationDelivery, Session
from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def test_act_is_not_marked_when_document_archive_fails(monkeypatch):
    import app.miniapp as miniapp

    configure(monkeypatch)
    calls = []

    def archive(*_args):
        calls.append("archive")
        raise ValueError("archive unavailable")

    monkeypatch.setattr(miniapp, "archived_document", archive)
    monkeypatch.setattr(miniapp, "mark_act_signed", lambda *_args: calls.append("signed"))
    with TestClient(app) as client:
        response = client.post("/api/miniapp/admin/bookings/999/act-signed",
                               headers={"X-Telegram-Init-Data": signed_init_data(200)})
    assert response.status_code == 409
    assert calls == ["archive"]


def test_act_is_marked_only_after_both_archives(monkeypatch):
    import app.miniapp as miniapp

    configure(monkeypatch)
    calls = []
    monkeypatch.setattr(miniapp, "archived_document", lambda _id, kind, _actor: calls.append(kind))
    monkeypatch.setattr(miniapp, "mark_act_signed", lambda *_args: calls.append("signed"))
    with TestClient(app) as client:
        response = client.post("/api/miniapp/admin/bookings/999/act-signed",
                               headers={"X-Telegram-Init-Data": signed_init_data(200)})
    assert response.status_code == 200
    assert calls == ["issue", "receipt", "signed"]


def test_failed_damage_photo_releases_its_stage_claim(monkeypatch):
    import app.miniapp as miniapp

    configure(monkeypatch)
    released = []
    monkeypatch.setattr(miniapp, "sanitize_image", lambda raw, _type: (raw, "image/jpeg"))
    monkeypatch.setattr(miniapp, "claim_booking_operation", lambda *_args: None)
    monkeypatch.setattr(miniapp, "release_booking_operation", lambda booking_id, actor_id: released.append((booking_id, actor_id)))
    with TestClient(app) as client:
        response = client.post("/api/miniapp/admin/bookings/999/inspection-photo",
                               headers={"X-Telegram-Init-Data": signed_init_data(100)},
                               data={"equipment_id": "1"}, files={"photo": ("damage.jpg", b"x", "image/jpeg")})
    assert response.status_code == 409
    assert released == [(999, 100)]


def test_failed_telegram_notification_is_logged_and_retried(monkeypatch):
    import app.bot as bot
    import app.notification_outbox as outbox

    configure(monkeypatch)
    attempts = []

    class FakeBot:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def send_message(self, *_args, **_kwargs):
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError("temporary Telegram outage")

    monkeypatch.setattr(bot, "make_bot", lambda _token: FakeBot())
    assert not asyncio.run(outbox.notify(None, 42, "status", "<b>test</b>"))
    with Session.begin() as session:
        delivery = session.scalar(select(NotificationDelivery))
        delivery.next_retry_at = outbox._now()
        assert delivery.attempts == 1 and delivery.last_error == "RuntimeError"
    asyncio.run(outbox.retry_pending_notifications())
    with Session() as session:
        delivery = session.scalar(select(NotificationDelivery))
        assert delivery.sent_at is not None and delivery.attempts == 2 and delivery.last_error is None
