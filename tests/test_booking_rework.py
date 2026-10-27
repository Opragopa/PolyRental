from datetime import timedelta

import pytest
from sqlalchemy import delete, select

from app.db import Audit, Booking, BookingRework, Session, StaffRole
from app.rental import Conflict, get_booking, mark_act_signed, record_inspection, return_for_rework, transition
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking


@pytest.fixture
def roles(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("ADMIN_IDS", "100,920001,920002")
    with Session.begin() as session:
        session.execute(delete(StaffRole).where(StaffRole.telegram_id.in_([920001, 920002])))
        session.add_all([StaffRole(telegram_id=920001, role="operator"), StaffRole(telegram_id=920002, role="operator")])
    yield
    with Session.begin() as session:
        session.execute(delete(StaffRole).where(StaffRole.telegram_id.in_([920001, 920002])))


def test_rework_requires_role_owner_and_comment_and_encrypts_reason(roles):
    booking_id = pending_booking()
    transition(booking_id, "confirmed", 100)
    with pytest.raises(PermissionError):
        return_for_rework(booking_id, "pending", "Причина", 920001)
    with pytest.raises(ValueError):
        return_for_rework(booking_id, "pending", "   ", 100)
    with pytest.raises(Conflict):
        return_for_rework(booking_id, "issued", "Причина", 100)
    assert return_for_rework(booking_id, "pending", "Частная причина", 100) == "pending"
    with Session() as session:
        event = session.scalar(select(BookingRework).where(BookingRework.booking_id == booking_id))
        assert event.from_status == "confirmed" and event.to_status == "pending"
        assert "Частная причина".encode() not in event.encrypted_comment
        assert session.scalar(select(Audit.id).where(Audit.booking_id == booking_id, Audit.action == "returned_for_rework"))
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        booking.status, booking.assignee_id = "preparing", 920001
    with pytest.raises(PermissionError):
        return_for_rework(booking_id, "confirmed", "Причина", 920002)
    assert return_for_rework(booking_id, "confirmed", "Причина", 920001) == "confirmed"


def test_return_rework_requires_fresh_inspection(roles):
    from app.rental import assign_booking_assets, create_booking, now
    article_id = article_with_assets("REWORK", 1)
    start = now() + timedelta(days=5)
    booking_id = create_booking(42, "Клиент", "@client", start, start + timedelta(hours=1),
                                [{"article_id": article_id, "quantity": 1}])
    transition(booking_id, "confirmed", 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    assign_booking_assets(booking_id, 100)
    equipment_id = get_booking(booking_id).assets[0].equipment_id
    record_inspection(booking_id, equipment_id, "pre_issue", "pass", {}, "", 100)
    transition(booking_id, "ready", 100)
    mark_act_signed(booking_id, 100)
    transition(booking_id, "issued", 100)
    transition(booking_id, "return_inspection", 100)
    record_inspection(booking_id, equipment_id, "check_in", "pass", {}, "", 100)
    assert return_for_rework(booking_id, "issued", "Нужна повторная проверка", 100) == "issued"
    transition(booking_id, "return_inspection", 100)
    with pytest.raises(Conflict, match="Проверьте каждый"):
        transition(booking_id, "returned", 100)
    record_inspection(booking_id, equipment_id, "check_in", "pass", {}, "", 100)
    assert transition(booking_id, "returned", 100) == "returned"


def test_rework_api_requires_comment_and_never_allows_issued(roles, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app import miniapp
    from app.miniapp_server import app
    from tests.test_miniapp import signed_init_data

    monkeypatch.setattr(miniapp, "notify_booking_status", AsyncMock())
    booking_id = pending_booking()
    transition(booking_id, "confirmed", 100)
    headers = lambda user_id: {"X-Telegram-Init-Data": signed_init_data(user_id)}
    url = f"/api/miniapp/admin/bookings/{booking_id}/rework"
    with TestClient(app) as client:
        assert client.post(url, headers=headers(920001), json={"target": "pending", "comment": "Причина"}).status_code == 403
        assert client.post(url, headers=headers(100), json={"target": "pending", "comment": " "}).status_code == 422
        assert client.post(url, headers=headers(100), json={"target": "pending", "comment": "Причина"}).json()["status"] == "pending"
        with Session.begin() as session:
            session.get(Booking, booking_id).status = "issued"
        assert client.post(url, headers=headers(100), json={"target": "preparing", "comment": "Причина"}).status_code == 409
