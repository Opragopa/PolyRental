"""Each change retains its own safe comparison, including repeated customer edits."""
from datetime import timedelta

from sqlalchemy import select

from app.booking_changes import change_view, propose_change, update_request
from app.db import BookingChange, BookingEvent, NotificationDelivery, Session
from app.notification_outbox import delivery_message
from app.rental import booking_history, booking_history_page, get_booking
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking


def updates(booking_id):
    return [row for row in booking_history(booking_id) if row["action"] == "request_updated"]


def test_proposal_acceptance_and_repeated_edits_keep_exact_comparisons(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    old_id = booking.lines[0].article_id
    new_id = article_with_assets("DIFF-NEW", 3)
    proposal = {"start": (booking.starts_at + timedelta(days=1)).isoformat(),
                "end": (booking.ends_at + timedelta(days=1)).isoformat(),
                "lines": [{"article_id": new_id, "quantity": 2}]}
    change_id = propose_change(booking_id, 100, "manager_edit", "PRIVATE REVIEW COMMENT", proposal)
    history = booking_history(booking_id)
    proposed = next(row for row in history if row["action"] == "request_changes_proposed")
    assert {row["kind"] for row in proposed["changes"]["lines"]} == {"added", "removed"}
    assert len(proposed["changes"]["dates"]) == 2
    assert "PRIVATE REVIEW COMMENT" not in str(history)
    with Session() as session:
        event = session.scalar(select(BookingEvent).where(BookingEvent.booking_id == booking_id).order_by(BookingEvent.version.desc()))
        message = session.scalar(select(NotificationDelivery).where(NotificationDelivery.event_id == event.id, NotificationDelivery.delivery_kind == "push"))
        assert "состав (2 поз.)" in delivery_message(message) and "сроки" in delivery_message(message)
    update_request(booking_id, 42, None, None, None, change_id)
    assert updates(booking_id)[0]["changes"] == proposed["changes"]
    start, end = get_booking(booking_id).starts_at, get_booking(booking_id).ends_at
    update_request(booking_id, 42, start, end, [{"article_id": new_id, "quantity": 1}])
    update_request(booking_id, 42, start, end, [{"article_id": new_id, "quantity": 3}])
    actual = updates(booking_id)
    assert len(actual) == 3
    assert [(row["changes"]["lines"][0]["before"], row["changes"]["lines"][0]["after"]) for row in actual[1:]] == [(2, 1), (1, 3)]
    assert old_id != new_id
    assert booking_history_page(booking_id, 0, 100)[0] == booking_history(booking_id)
    latest = change_view(booking_id, 200)
    assert "comment" not in latest and "history" not in latest
    assert latest["before"]["lines"][0]["quantity"] == 1
    assert latest["after"]["lines"][0]["quantity"] == 3


def test_client_correction_uses_applied_snapshot_and_purged_details_are_explicit(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    change_id = propose_change(booking_id, 100, "client_fix", "PRIVATE CORRECTION")
    start, end = booking.starts_at + timedelta(days=1), booking.ends_at + timedelta(days=1)
    lines = [{"article_id": row.article_id, "quantity": row.quantity} for row in booking.lines]
    update_request(booking_id, 42, start, end, lines, change_id)
    view = change_view(booking_id, 42)
    assert view["after"]["start"] == start.isoformat()
    assert len(updates(booking_id)[0]["changes"]["dates"]) == 2
    assert "PRIVATE CORRECTION" not in str(booking_history(booking_id))
    with Session.begin() as session:
        change = session.get(BookingChange, change_id)
        change.ciphertext = b""
    assert updates(booking_id)[0]["changes_unavailable"] is True
