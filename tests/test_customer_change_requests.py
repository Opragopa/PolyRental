import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.customer_changes import decide_request, request_changes, view_request
from app.db import Audit, Booking, CustomerChangeRequest, NotificationDelivery, Session, StaffRole
from app.miniapp import booking_view
from app.miniapp_server import app
from app.rental import Conflict, assign_booking_assets, booking_history, get_booking, transition
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def confirmed_booking(identity="verified"):
    booking_id = pending_booking()
    transition(booking_id, "confirmed", 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = identity
    return booking_id


@pytest.mark.parametrize("identity", ["submitted", "verified"])
def test_request_requires_reason_and_preserves_confirmed_booking(monkeypatch, identity):
    configure(monkeypatch)
    booking_id = confirmed_booking(identity)
    before = get_booking(booking_id)
    with pytest.raises(ValueError):
        request_changes(booking_id, 42, "   ")
    with pytest.raises(ValueError):
        request_changes(booking_id, 42, "x" * 2001)
    row = request_changes(booking_id, 42, "  Нужно перенести съёмку  ")
    assert row["status"] == "pending"
    after = get_booking(booking_id)
    assert (after.status, after.starts_at, after.ends_at) == ("confirmed", before.starts_at, before.ends_at)
    assert view_request(booking_id, 42)["reason"] == "Нужно перенести съёмку"
    assert booking_view(after)["can_request_changes"] is False
    with Session() as session:
        stored = session.get(CustomerChangeRequest, row["id"])
        assert "Нужно".encode() not in stored.ciphertext
        assert all("Нужно" not in item.message for item in session.scalars(select(NotificationDelivery).where(NotificationDelivery.booking_id == booking_id)))
    assert "Нужно" not in str(booking_history(booking_id))


def test_only_owner_can_request_and_only_before_preparation(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    with pytest.raises(Conflict):
        request_changes(booking_id, 42, "Причина")
    transition(booking_id, "confirmed", 100)
    with pytest.raises(Conflict):
        request_changes(booking_id, 42, "Анкета ещё не отправлена")
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    with pytest.raises(ValueError):
        request_changes(booking_id, 43, "Чужая заявка")
    with pytest.raises(ValueError):
        view_request(booking_id, 43)
    assign_booking_assets(booking_id, 100)
    with pytest.raises(Conflict):
        request_changes(booking_id, 42, "Подготовка началась")


def test_operator_approval_opens_existing_edit_flow_then_requires_confirmation(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        session.get(StaffRole, 200).role = "operator"
    booking_id = confirmed_booking()
    request = request_changes(booking_id, 42, "Изменить количество")
    with pytest.raises(Conflict, match="запрос клиента"):
        assign_booking_assets(booking_id, 100)
    assert decide_request(booking_id, request["id"], 200, True)["status"] == "approved"
    assert decide_request(booking_id, request["id"], 200, True)["status"] == "approved"
    booking = get_booking(booking_id)
    assert booking.status == "needs_changes"
    from app.booking_changes import change_view, update_request
    change = change_view(booking_id, 42)
    assert change["change_type"] == "client_fix"
    update_request(booking_id, 42, booking.starts_at, booking.ends_at,
                   [{"article_id": line.article_id, "quantity": line.quantity} for line in booking.lines], change["id"])
    assert get_booking(booking_id).status == "pending"
    assert transition(booking_id, "confirmed", 100) == "confirmed"


def test_rejection_keeps_booking_and_stale_decisions_cannot_apply_to_new_request(monkeypatch):
    configure(monkeypatch)
    booking_id = confirmed_booking()
    first = request_changes(booking_id, 42, "Изменить сроки")
    decide_request(booking_id, first["id"], 100, False, "Сроки уже согласованы")
    assert get_booking(booking_id).status == "confirmed"
    assert view_request(booking_id, 42)["decision_comment"] == "Сроки уже согласованы"
    assert booking_view(get_booking(booking_id))["change_status"] is None
    assert booking_view(get_booking(booking_id))["can_request_changes"] is True
    second = request_changes(booking_id, 42, "Новая причина")
    with pytest.raises(Conflict):
        decide_request(booking_id, first["id"], 100, True)
    decide_request(booking_id, second["id"], 100, False)
    assert assign_booking_assets(booking_id, 100) == "preparing"


def test_double_submit_and_competing_decisions_are_serialized(monkeypatch):
    configure(monkeypatch)
    booking_id = confirmed_booking()
    with ThreadPoolExecutor(max_workers=2) as pool:
        requests = list(pool.map(lambda _: request_changes(booking_id, 42, "Причина"), range(2)))
    assert requests[0]["id"] == requests[1]["id"]
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(Audit).where(Audit.booking_id == booking_id, Audit.action == "customer_change_requested")) == 1
    def decide(approve):
        try:
            return decide_request(booking_id, requests[0]["id"], 100, approve)["status"]
        except Conflict:
            return "conflict"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(decide, [True, False]))
    assert results.count("conflict") == 1


def test_request_and_start_preparation_cannot_both_succeed(monkeypatch):
    configure(monkeypatch)
    booking_id = confirmed_booking()
    def run(action):
        try:
            action()
            return "ok"
        except Conflict:
            return "conflict"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, [lambda: request_changes(booking_id, 42, "Изменить даты"), lambda: assign_booking_assets(booking_id, 100)]))
    assert sorted(results) == ["conflict", "ok"]


def test_cancellation_obsoletes_request_and_retention_removes_reason(monkeypatch):
    configure(monkeypatch)
    booking_id = confirmed_booking()
    request = request_changes(booking_id, 42, "Секретный комментарий")
    transition(booking_id, "cancelled", 42, 42)
    assert view_request(booking_id, 42)["status"] == "obsolete"
    with pytest.raises(Conflict):
        decide_request(booking_id, request["id"], 100, True)
    from app.pii import _purge_private_comments
    with Session.begin() as session:
        _purge_private_comments(session, booking_id)
    assert "Секретный" not in view_request(booking_id, 42)["reason"]


def test_http_enforces_owner_reason_and_operator_roles(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    booking_id = confirmed_booking("submitted")
    headers = lambda uid: {"X-Telegram-Init-Data": signed_init_data(uid)}
    url = f"/api/miniapp/bookings/{booking_id}/change-request"
    with TestClient(app) as client:
        assert client.post(url, json={"reason": "Причина"}).status_code == 401
        assert client.post(url, headers=headers(43), json={"reason": "Причина"}).status_code == 422
        assert client.post(url, headers=headers(42), json={"reason": "  "}).status_code == 422
        response = client.post(url, headers=headers(42), json={"reason": "Нужна другая дата"})
        assert response.status_code == 200
        request_id = response.json()["id"]
        assert client.get(url, headers=headers(43)).status_code == 422
        assert client.get(url, headers=headers(100)).json()["reason"] == "Нужна другая дата"
        decision = f"/api/miniapp/admin/bookings/{booking_id}/change-request/{request_id}/decision"
        assert client.post(decision, headers=headers(42), json={"approve": True}).status_code == 403
        assert client.post(decision, headers=headers(100), json={"approve": False}).status_code == 200


def test_chat_requires_reason_confirmation_and_uses_same_backend(monkeypatch):
    configure(monkeypatch)
    from app import customer_changes_chat as chat
    from tests.test_chat_customer_integration import MemoryState
    monkeypatch.setattr(chat, "private", lambda _: True)
    monkeypatch.setattr(chat, "show_customer_booking", AsyncMock())
    booking_id = confirmed_booking("submitted")
    query = SimpleNamespace(data=f"ccr:ask:{booking_id}", from_user=SimpleNamespace(id=42), answer=AsyncMock(), message=SimpleNamespace(answer=AsyncMock()))
    state = MemoryState()
    asyncio.run(chat.request_action(query, state))
    message = SimpleNamespace(text="  ", from_user=SimpleNamespace(id=42), answer=AsyncMock())
    asyncio.run(chat.reason_message(message, state))
    assert view_request(booking_id, 42) is None
    message.text = "Перенести съёмку"
    asyncio.run(chat.reason_message(message, state))
    assert state.state == chat.ChangeReason.confirm.state
    query.data = f"ccr:send:{booking_id}"
    asyncio.run(chat.request_action(query, state))
    assert view_request(booking_id, 42)["status"] == "pending"
