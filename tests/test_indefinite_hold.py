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


@pytest.mark.parametrize("status", ["issued", "return_inspection"])
def test_planned_end_releases_unreturned_equipment_in_every_availability_path(status):
    from app.db import Article, BookingAsset, BookingLine, Equipment
    from app.rental import (AvailabilitySnapshot, _asset_conflicts, _reserved_quantity,
                            calendar_availability, nearest_available_period)
    from tests.test_integration import article_with_assets
    article_id = article_with_assets("PLANNED-END", 1)
    end = now() - timedelta(hours=1)
    start = end - timedelta(days=2)
    with Session.begin() as session:
        # Legacy buffer metadata must not introduce a new post-return delay.
        session.get(Article, article_id).buffer_hours = 24
        asset_id = session.scalar(select(Equipment.id).where(Equipment.article_id == article_id))
        booking = Booking(customer_id=42, customer_name="QA", customer_contact="@qa", status=status,
                          starts_at=start, ends_at=end)
        session.add(booking); session.flush()
        booking_id = booking.id
        line = BookingLine(booking_id=booking.id, article_id=article_id, quantity=1, hourly_rate=0)
        session.add(line); session.flush()
        session.add(BookingAsset(booking_id=booking.id, equipment_id=asset_id, booking_line_id=line.id))
    with Session() as session:
        snapshot = AvailabilitySnapshot(session, [article_id], start, end + timedelta(days=3))
        for left, right, expected in ((start, end, 1), (end-timedelta(minutes=1),end+timedelta(minutes=1),1),
                                      (end,end+timedelta(hours=1),0)):
            assert snapshot.peak(article_id,left,right) == expected
            assert _reserved_quantity(session,article_id,left,right) == expected
        target = Booking(id=-1, starts_at=end, ends_at=end+timedelta(hours=1))
        assert not _asset_conflicts(session,target,asset_id)
        target.starts_at = end-timedelta(minutes=1)
        assert _asset_conflicts(session,target,asset_id)
        assert session.get(Booking,booking_id).status == status
    future = (now()+timedelta(days=4)).replace(minute=0,second=0,microsecond=0)
    rows = {item['id']:item for item in availability(future,future+timedelta(hours=1))}
    assert rows[article_id]['available_quantity'] == 1
    selection = [{'article_id':article_id,'quantity':1}]
    calendar = calendar_availability(future,future+timedelta(hours=1),selection,future.date())
    assert calendar['selected'] == 'all'
    assert set(calendar['daily'].values()) == {'all'}
    assert nearest_available_period(future,future+timedelta(hours=1),selection)['start'] == future.isoformat()
    new_id=create_booking(43,'Следующий клиент','@next_user',future,future+timedelta(hours=1),selection)
    assert transition(new_id,'confirmed',100,actor_name='Оператор') == 'confirmed'
    with Session() as session:
        assert session.get(Booking,booking_id).status == status
