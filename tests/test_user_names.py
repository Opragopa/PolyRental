from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.db import Audit, BookingHandover, BookingOperationLease, ClientProfile, Session, StaffRole
from app.handover import handover_state
from app.miniapp_server import app
from app.rental import booking_history, booking_history_page, claim_booking_operation, operation_lease_states
from app.user_names import clean_name, remember_user_name, telegram_name, user_names
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


@pytest.mark.parametrize("value", ["123456789", "ID 123456789", "оператор 123456789", "Сотрудник ID 123456789"])
def test_legacy_id_labels_are_not_names(value):
    assert clean_name(value) == ""


def test_names_refresh_without_changing_roles_or_losing_known_names():
    remember_user_name({"id": 100, "first_name": "Анна", "last_name": "Иванова", "username": "anna"})
    remember_user_name({"id": 42, "username": "client_name"})
    remember_user_name({"id": 42})
    with Session() as session:
        assert user_names(session, [100, 42]) == {100: "Анна Иванова", 42: "@client_name"}
        assert session.get(StaffRole, 100).role == "admin"
        assert session.get(ClientProfile, 42).display_name == "@client_name"
    remember_user_name(SimpleNamespace(id=42, first_name="Борис", last_name="", username="client_name"))
    with Session() as session:
        assert user_names(session, [42])[42] == "Борис"
    assert telegram_name({"id": 999}) == "Пользователь"


def test_authenticated_names_only_are_remembered(monkeypatch):
    configure(monkeypatch)
    client = TestClient(app)
    assert client.get("/api/miniapp/me", headers={"X-Telegram-Init-Data": "invalid"}).status_code == 401
    with Session() as session:
        assert session.get(ClientProfile, 42) is None
    assert client.get("/api/miniapp/me", headers={"X-Telegram-Init-Data": signed_init_data(42)}).status_code == 200
    with Session() as session:
        assert session.get(ClientProfile, 42).display_name == "Анна"


def test_history_names_match_on_all_pages_and_assignment_targets():
    booking_id = pending_booking()
    remember_user_name({"id": 42, "first_name": "Виктор"})
    remember_user_name({"id": 100, "username": "manager_anna"})
    remember_user_name({"id": 200, "first_name": "Борис"})
    with Session.begin() as session:
        session.add_all([Audit(booking_id=booking_id, actor_id=100, action="assignee:200"),
                         Audit(booking_id=booking_id, actor_id=0, action="expired")])
    items = booking_history(booking_id)
    assignment = next(item for item in items if item["action"] == "assignee:200")
    assert assignment["actor_id"] == 100
    assert assignment["actor_name"] == "@manager_anna"
    assert assignment["target_name"] == "Борис"
    assert next(item for item in items if item["action"] == "created")["actor_name"] == "Виктор"
    assert next(item for item in items if item["action"] == "expired")["actor_name"] == "Система"
    pages = [booking_history_page(booking_id, page, 1)[0][0] for page in range(len(items))]
    assert pages == items


def test_legacy_handover_and_claim_names_resolve_without_rewriting_history():
    booking_id = pending_booking()
    remember_user_name({"id": 100, "first_name": "Анна"})
    claim_booking_operation(booking_id, 100, "оператор 100")
    with Session.begin() as session:
        session.get(BookingOperationLease, (booking_id, "pending")).actor_name = "ID 100"
        session.add(BookingHandover(booking_id=booking_id, data={"issued_by": 100, "issued_by_name": "Сотрудник ID 100"}))
    assert operation_lease_states()[booking_id]["actor_name"] == "Анна"
    assert handover_state(booking_id)["issued_by_name"] == "Анна"
    with Session() as session:
        assert session.get(BookingHandover, booking_id).data["issued_by_name"] == "Сотрудник ID 100"


def test_support_names_preserve_access_checks(monkeypatch):
    configure(monkeypatch)
    from app.support import SupportConflict, claim_thread, read_messages, submit_question, support_threads_page
    remember_user_name({"id": 42, "username": "customer_name"})
    remember_user_name({"id": 200, "first_name": "Борис"})
    thread = submit_question(42, None, "profile", "Вопрос")
    claim_thread(thread["id"], 200)
    assert support_threads_page()[0][0]["owner_name"] == "Борис"
    assert read_messages(thread["id"], 200)["customer_name"] == "@customer_name"
    with pytest.raises(SupportConflict):
        read_messages(thread["id"], 100)
