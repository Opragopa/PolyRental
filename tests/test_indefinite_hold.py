from datetime import timedelta

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
    assert not next(item for item in availability(start, end) if item["id"] == article["id"])["available"]
    assert transition(booking_id, "confirmed", 100, actor_name="Оператор") == "confirmed"
