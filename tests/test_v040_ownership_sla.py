from datetime import datetime, timedelta
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Audit, Booking, NotificationDelivery, Session, SlaEscalation
from app.miniapp_server import app
from app.request_sla import request_sla
from app.sla_clock import MOSCOW, add_business_time
from app.sla_escalations import queue_sla_escalations
from app.rental import get_booking, transition
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def test_transition_claims_and_reassignment_is_staff_only(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    assert get_booking(booking_id).assignee_id is None
    transition(booking_id, 'confirmed', 100)
    booking = get_booking(booking_id)
    assert booking.assignee_id == 100 and booking.claimed_at is not None
    assert request_sla(booking)['stage'] == 'resolve'
    url = f'/api/miniapp/admin/bookings/{booking_id}/assignee'
    with TestClient(app) as client:
        assert client.put(url, headers=headers(42), json={'assignee_id':200}).status_code == 403
        assert client.put(url, headers=headers(100), json={'assignee_id':42}).status_code == 422
        assert client.put(url, headers=headers(100), json={'assignee_id':200}).json()['assignee_id'] == 200
        assert get_booking(booking_id).claimed_at == booking.claimed_at
        transition(booking_id, 'cancelled', 100)
        closed = get_booking(booking_id)
        assert closed.assignee_id is None and closed.sla_closed_at is not None


def test_unclaimed_escalations_are_idempotent_and_content_free(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv('SLA_SHARED_CHAT_ID', '-12345')
    monkeypatch.setenv('SLA_HOLIDAYS', '')
    booking_id = pending_booking()
    start = datetime(2026, 5, 29, 16, 30, tzinfo=MOSCOW)
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.created_at = start
    claim_breach = add_business_time(start, timedelta(hours=2)) + timedelta(seconds=1)
    assert queue_sla_escalations(claim_breach) == 1
    assert queue_sla_escalations(claim_breach) == 0
    admin_breach = add_business_time(start, timedelta(hours=26)) + timedelta(seconds=1)
    assert queue_sla_escalations(admin_breach) == 1
    with Session() as session:
        events = session.scalars(select(SlaEscalation).where(SlaEscalation.booking_id == booking_id)).all()
        deliveries = session.scalars(select(NotificationDelivery).where(NotificationDelivery.booking_id == booking_id, NotificationDelivery.event.like('sla_%'))).all()
        assert {row.tier for row in events} == {'claim_shared', 'unclaimed_admin'}
        assert {row.recipient_id for row in deliveries} == {-12345, 100, 200}
        assert all('@client' not in row.message and 'Клиент' not in row.message for row in deliveries)
        assert session.scalar(select(Audit.id).where(Audit.booking_id == booking_id, Audit.action == 'sla_claim_shared'))


def test_claimed_request_escalates_after_24_and_48_business_hours(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv('SLA_SHARED_CHAT_ID', '-12345')
    monkeypatch.setenv('SLA_HOLIDAYS', '')
    booking_id = pending_booking()
    start = datetime(2026, 6, 1, 8, 30, tzinfo=MOSCOW)
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.created_at = start
        booking.claimed_at = start
        booking.assignee_id = 100
    due24 = add_business_time(start, timedelta(hours=24))
    assert queue_sla_escalations(due24 - timedelta(seconds=1)) == 0
    assert queue_sla_escalations(due24 + timedelta(seconds=1)) == 1
    due48 = add_business_time(start, timedelta(hours=48))
    assert queue_sla_escalations(due48 + timedelta(seconds=1)) == 1
    with Session() as session:
        assert {row.tier for row in session.scalars(select(SlaEscalation)).all()} == {'resolve_shared', 'resolve_admin'}
