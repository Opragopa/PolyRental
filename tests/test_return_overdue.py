import asyncio
from datetime import datetime, timedelta

import pytest
from aiogram.exceptions import TelegramForbiddenError
from aiogram.methods import SendMessage
from sqlalchemy import select

from app import notification_outbox
from app.client_profile import set_reminders_enabled
from app.db import Booking, BookingAsset, BookingLine, NotificationDelivery, Session
from app.handover import customer_attest, handover_state
from app.notification_inbox import inbox
from app.operator_preferences import save_preferences
from app.rental import (AvailabilitySnapshot, Conflict, _asset_conflicts, _reserved_quantity, get_booking,
                        now, record_inspection, start_return_without_customer, transition)
from app.return_overdue import (CUSTOMER_EVENT, MANAGER_EVENT, OPERATOR_EVENT, RISK_EVENT,
                                at_risk, overdue, queue_return_notifications)
from app.sla_clock import MOSCOW
from tests.test_completion_workflows import ready_booking
from tests.test_operator_return import issued_booking


FRIDAY = datetime(2026, 10, 30, 17, tzinfo=MOSCOW)
MONDAY = datetime(2026, 11, 2, 9, tzinfo=MOSCOW)


def _set_deadline(booking_id, deadline, assignee=100):
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.starts_at = deadline - timedelta(days=1)
        booking.ends_at = deadline
        booking.assignee_id = assignee


def _return_deliveries(booking_id):
    with Session() as session:
        return {row.event: row for row in session.scalars(select(NotificationDelivery).where(
            NotificationDelivery.booking_id == booking_id, NotificationDelivery.return_due_at.is_not(None)))}


@pytest.fixture
def telegram_messages(monkeypatch):
    messages = []

    class RecordingBot:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def send_message(self, chat_id, message, **_kwargs):
            messages.append((chat_id, message))

    monkeypatch.setenv("BOT_TOKEN", "123456:test")
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    monkeypatch.setattr("app.bot.make_bot", lambda _token: RecordingBot())
    return messages


def test_overdue_routes_once_and_escalates_after_weekend(monkeypatch, telegram_messages):
    booking_id = issued_booking(monkeypatch)
    _set_deadline(booking_id, FRIDAY, assignee=200)
    set_reminders_enabled(42, False)
    save_preferences(200, "16:00", "19:00")
    assert queue_return_notifications(FRIDAY - timedelta(microseconds=1)) == 0
    assert queue_return_notifications(FRIDAY) == 2
    assert queue_return_notifications(FRIDAY) == 0
    rows = _return_deliveries(booking_id)
    assert rows[CUSTOMER_EVENT].recipient_id == 42
    assert "30.10.2026 17:00 МСК" in rows[CUSTOMER_EVENT].message
    assert rows[OPERATOR_EVENT].recipient_id == 200
    assert rows[OPERATOR_EVENT].next_retry_at == FRIDAY + timedelta(hours=2)
    assert queue_return_notifications(MONDAY - timedelta(microseconds=1)) == 0
    assert queue_return_notifications(MONDAY) == 1
    rows = _return_deliveries(booking_id)
    assert rows[MANAGER_EVENT].recipient_id == 100
    monkeypatch.setattr(notification_outbox, "_now", lambda: MONDAY)
    for event in (CUSTOMER_EVENT, OPERATOR_EVENT, MANAGER_EVENT):
        assert asyncio.run(notification_outbox.deliver_notification(rows[event].id))
        assert asyncio.run(notification_outbox.deliver_notification(rows[event].id))
    assert [recipient for recipient, _ in telegram_messages] == [42, 200, 100]
    assert all(row.sent_at == MONDAY and row.attempts == 1 for row in _return_deliveries(booking_id).values())


def test_client_attestation_does_not_stop_return_alert_but_staff_confirmation_does(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    _set_deadline(booking_id, FRIDAY)
    customer_attest(booking_id, 42, "returning")
    assert overdue(get_booking(booking_id), handover_state(booking_id), FRIDAY)
    assert queue_return_notifications(FRIDAY) == 2
    cycle = get_booking(booking_id).inspection_cycle_started_at
    start_return_without_customer(booking_id, 100)
    start_return_without_customer(booking_id, 100)
    data = handover_state(booking_id)
    assert data["returning_at"] and data["operator_return"]["actor_id"] == 100
    assert not overdue(get_booking(booking_id), data, MONDAY)
    assert get_booking(booking_id).inspection_cycle_started_at == cycle
    assert all(row.cancelled_at for row in _return_deliveries(booking_id).values())
    assert queue_return_notifications(MONDAY) == 0


@pytest.mark.parametrize("early", [timedelta(minutes=5), timedelta(0)])
def test_confirming_at_or_before_deadline_does_not_queue_overdue_notice(monkeypatch, early):
    booking_id = issued_booking(monkeypatch)
    _set_deadline(booking_id, FRIDAY)
    monkeypatch.setattr("app.rental.now", lambda: FRIDAY - early)
    start_return_without_customer(booking_id, 100)
    assert queue_return_notifications(MONDAY) == 0
    assert not _return_deliveries(booking_id)


def test_inbox_survives_telegram_refusal(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    _set_deadline(booking_id, FRIDAY)
    queue_return_notifications(FRIDAY)
    row = _return_deliveries(booking_id)[CUSTOMER_EVENT]
    monkeypatch.setenv("BOT_TOKEN", "123456:test")
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    monkeypatch.setattr(notification_outbox, "_now", lambda: FRIDAY)

    class BlockedBot:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def send_message(self, chat_id, message, *, reply_markup, **_kwargs):
            labels = {button.text for line in reply_markup.inline_keyboard for button in line}
            assert {"Открыть заявку", "Связаться с оператором"} <= labels
            raise TelegramForbiddenError(SendMessage(chat_id=chat_id, text=message), "Forbidden")

    monkeypatch.setattr("app.bot.make_bot", lambda _token: BlockedBot())
    assert not asyncio.run(notification_outbox.deliver_notification(row.id))
    assert _return_deliveries(booking_id)[CUSTOMER_EVENT].last_error == "TelegramForbiddenError"
    assert any(item.get("booking_id") == booking_id and not item["staff"] for item in inbox(42)["items"])
    assert not any(item.get("booking_id") == booking_id for item in inbox(43)["items"])


def test_staff_delivery_rechecks_quiet_hours_changed_after_enqueue(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    _set_deadline(booking_id, FRIDAY, assignee=200)
    queue_return_notifications(FRIDAY)
    row = _return_deliveries(booking_id)[OPERATOR_EVENT]
    save_preferences(200, "16:00", "19:00")
    monkeypatch.setattr(notification_outbox, "_now", lambda: FRIDAY + timedelta(minutes=1))

    assert not asyncio.run(notification_outbox.deliver_notification(row.id))
    delayed = _return_deliveries(booking_id)[OPERATOR_EVENT]
    assert delayed.attempts == 0
    assert delayed.next_retry_at == FRIDAY + timedelta(hours=2)


def test_partial_issue_holds_only_assigned_asset_until_inspection_ends(monkeypatch, telegram_messages):
    booking_id = ready_booking(monkeypatch, partial=True)
    transition(booking_id, "ready", 100)
    transition(booking_id, "issued", 100)
    _set_deadline(booking_id, FRIDAY)
    held = get_booking(booking_id).assets[0]
    article_id = held.equipment.article_id
    start = now() + timedelta(days=8)
    end = start + timedelta(hours=2)
    with Session.begin() as session:
        following = Booking(customer_id=43, customer_name="QA", customer_contact="", status="confirmed",
                            starts_at=start, ends_at=end, assignee_id=100)
        session.add(following)
        session.flush()
        following_id = following.id
        session.add(BookingLine(booking_id=following_id, article_id=article_id, quantity=2, hourly_rate=0))
        session.flush()
        assert at_risk(session, following)
        assert _asset_conflicts(session, following, held.equipment_id)
        assert _reserved_quantity(session, article_id, start, end, following_id) == 1
        assert AvailabilitySnapshot(session, [article_id], start, end, exclude_booking_id=following_id).peak(
            article_id, start, end) == 1
    queue_return_notifications(now())
    risk = _return_deliveries(following_id)[RISK_EVENT]
    assert risk.recipient_id == 100
    monkeypatch.setattr(notification_outbox, "_now", lambda: risk.next_retry_at)
    assert asyncio.run(notification_outbox.deliver_notification(risk.id))
    assert telegram_messages == [(100, risk.message)]
    assert get_booking(following_id).status == "confirmed"
    start_return_without_customer(booking_id, 100)
    with Session() as session:
        assert at_risk(session, session.get(Booking, following_id))
    record_inspection(booking_id, held.equipment_id, "check_in", "pass", {}, "", 100)
    transition(booking_id, "returned", 100)
    with Session() as session:
        following = session.get(Booking, following_id)
        assert not at_risk(session, following)
        assert not _asset_conflicts(session, following, held.equipment_id)
        assert _reserved_quantity(session, article_id, start, end, following_id) == 0


def test_final_issue_rejects_already_assigned_asset_still_out(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    transition(booking_id, "ready", 100)
    asset = get_booking(booking_id).assets[0]
    with Session.begin() as session:
        previous = Booking(customer_id=43, customer_name="QA", customer_contact="", status="issued",
                           starts_at=FRIDAY - timedelta(days=1), ends_at=FRIDAY)
        session.add(previous)
        session.flush()
        line = BookingLine(booking_id=previous.id, article_id=asset.equipment.article_id, quantity=1, hourly_rate=0)
        session.add(line)
        session.flush()
        session.add(BookingAsset(booking_id=previous.id, booking_line_id=line.id, equipment_id=asset.equipment_id))
    with pytest.raises(Conflict, match="ещё не принят"):
        transition(booking_id, "issued", 100)
    assert get_booking(booking_id).status == "ready"
