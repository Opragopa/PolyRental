from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import Booking, Session
from app.rental import availability, create_booking, expire_holds, now, save_equipment, transition


def test_pending_booking_never_expires_before_operator_decision():
    save_equipment("HOLD-001", "Камера для удержания", "", 0, "available")
    start = now() + timedelta(days=5)
    end = start + timedelta(days=1)
    article = next(item for item in availability(start, end) if item["name"] == "Камера для удержания")
    booking_id = create_booking(42, "Анна", "@anna1", start, end,
                                [{"article_id": article["id"], "quantity": 1}])
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        assert booking.hold_expires_at is None
        booking.hold_expires_at = now() - timedelta(days=1)
        expire_holds(session)
        assert booking.status == "pending"
    assert next(item for item in availability(start, end) if item["id"] == article["id"])["available"]
    assert transition(booking_id, "confirmed", 100, actor_name="Оператор") == "confirmed"
    assert not next(item for item in availability(start, end) if item["id"] == article["id"])["available"]


@pytest.mark.parametrize("status,blocked", [
    ("pending", False), ("needs_changes", False), ("returned", False),
    ("cancelled", False), ("confirmed", True), ("preparing", True),
    ("ready", True), ("issued", True), ("return_inspection", True),
])
def test_status_controls_reservation_without_return_buffer(status, blocked):
    save_equipment("STATUS-001", "Проверка статуса", "", 0, "available")
    start = now() + timedelta(days=5)
    end = start + timedelta(hours=1)
    article = next(item for item in availability(start, end) if item["name"] == "Проверка статуса")
    booking_id = create_booking(42, "Анна", "@anna", start, end,
                                [{"article_id": article["id"], "quantity": 1}])
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.status = status
        if status == "returned":
            booking.returned_at = now()
    result = next(item for item in availability(start, end) if item["id"] == article["id"])
    assert result["available"] is not blocked
