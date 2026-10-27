"""The initial role rollout stores data without changing existing access."""
import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import delete, text
from sqlalchemy.exc import IntegrityError

from app.db import Session, StaffRole, engine
from app.roles import role_for, staff_allows, staff_subrole


@pytest.fixture
def staff_roles():
    ids = [910001, 910002, 910003]
    with Session.begin() as session:
        session.execute(delete(StaffRole).where(StaffRole.telegram_id.in_(ids)))
        session.add_all([
            StaffRole(telegram_id=ids[0], role="operator"),
            StaffRole(telegram_id=ids[1], role="manager"),
            StaffRole(telegram_id=ids[2], role="admin"),
        ])
    yield ids
    with Session.begin() as session:
        session.execute(delete(StaffRole).where(StaffRole.telegram_id.in_(ids)))


def test_subrole_requires_admin_membership_and_keeps_pii_independent(monkeypatch, staff_roles):
    operator, manager, admin = staff_roles
    monkeypatch.setenv("ADMIN_IDS", f"{operator},{manager}")
    monkeypatch.setenv("PII_ADMIN_IDS", str(manager))
    assert staff_subrole(operator) == "operator"
    assert staff_subrole(manager) == "manager"
    assert staff_subrole(admin) is None
    assert staff_subrole(str(operator)) is None
    assert role_for(operator)["admin"] and not role_for(operator)["pii_admin"]
    assert role_for(manager)["admin"] and role_for(manager)["pii_admin"]
    monkeypatch.setenv("ADMIN_IDS", str(admin))
    assert staff_subrole(operator) is None
    assert staff_subrole(admin) == "admin"


def test_invalid_staff_role_is_rejected():
    with pytest.raises(IntegrityError):
        with Session.begin() as session:
            session.add(StaffRole(telegram_id=910004, role="owner"))
            session.flush()


def test_role_hierarchy_and_unknown_ids_fail_closed(monkeypatch, staff_roles):
    operator, manager, admin = staff_roles
    monkeypatch.setenv("ADMIN_IDS", f"{operator},{manager},{admin},910099")
    monkeypatch.setenv("PII_ADMIN_IDS", "910099")
    assert staff_allows(operator, "operator")
    assert not staff_allows(operator, "manager")
    assert staff_allows(manager, "operator") and staff_allows(manager, "manager")
    assert not staff_allows(manager, "admin")
    assert staff_allows(admin, "admin") and staff_allows(admin, "manager")
    assert not staff_allows(910099, "operator")


def test_transition_api_checks_subrole_not_pii_membership(monkeypatch, staff_roles):
    from fastapi.testclient import TestClient
    from app.miniapp_server import app
    from tests.test_miniapp import configure, signed_init_data
    from tests.test_operation_lease import pending_booking

    configure(monkeypatch)
    operator, manager, admin = staff_roles
    monkeypatch.setenv("ADMIN_IDS", f"{operator},{manager},{admin}")
    monkeypatch.setenv("PII_ADMIN_IDS", str(operator))
    booking_id = pending_booking()
    def headers(user_id):
        return {"X-Telegram-Init-Data": signed_init_data(user_id)}
    url = f"/api/miniapp/admin/bookings/{booking_id}/transition"
    with TestClient(app) as client:
        assert client.post(url, headers=headers(operator), json={"action": "confirmed"}).status_code == 403
        assert client.post(url, headers=headers(manager), json={"action": "confirmed"}).status_code == 200
        assert client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=headers(manager)).status_code == 403


def test_bot_and_web_do_not_bypass_transition_role(monkeypatch, staff_roles):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    from app import bot, web

    operator, manager, _ = staff_roles
    monkeypatch.setenv("ADMIN_IDS", f"{operator},{manager}")
    message = SimpleNamespace(text="/confirm 123", from_user=SimpleNamespace(id=operator), answer=AsyncMock())
    asyncio.run(bot.change(message, SimpleNamespace()))
    assert "Недостаточно прав" in message.answer.call_args.args[0]
    monkeypatch.setattr(web, "require_admin", lambda request: operator)
    with pytest.raises(HTTPException) as error:
        asyncio.run(web.change_booking(SimpleNamespace(), 123, "confirmed"))
    assert error.value.status_code == 403


def test_migration_seeds_admins_without_importing_pii_roles(monkeypatch):
    monkeypatch.setenv("ADMIN_IDS", "910011,910012")
    monkeypatch.setenv("PII_ADMIN_IDS", "910012,910013")
    path = Path(__file__).parents[1] / "alembic/versions/20261028_27_staff_roles.py"
    spec = importlib.util.spec_from_file_location("staff_roles_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    schema = "staff_test_" + uuid4().hex
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            rows = connection.execute(text("SELECT telegram_id, role FROM staff_roles ORDER BY telegram_id")).all()
            assert rows == [(910011, "admin"), (910012, "admin")]
            connection.execute(text("UPDATE staff_roles SET role='operator' WHERE telegram_id=910011"))
            migration.upgrade()
            rows = connection.execute(text("SELECT telegram_id, role FROM staff_roles ORDER BY telegram_id")).all()
            assert rows == [(910011, "operator"), (910012, "admin")]
        finally:
            transaction.rollback()
