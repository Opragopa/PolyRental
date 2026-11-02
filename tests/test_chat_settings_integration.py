import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient

from app import chat_settings as settings
from app.client_profile import profile_state
from app.db import Session,StaffRole,TrustedSigner
from app.handover import set_trusted_signer
from app.miniapp_server import app
from app.rental import Conflict
from app.roles import set_staff_role
from tests.test_miniapp import configure,signed_init_data


def test_role_update_conflict_and_self_demotion_guard(monkeypatch):
    configure(monkeypatch)
    with pytest.raises(Conflict,match='Собственную'):set_staff_role(100,100,'manager')
    set_staff_role(100,200,'operator')
    with pytest.raises(Conflict,match='изменилась'):set_staff_role(100,200,'admin','manager',True)
    with Session() as session:assert session.get(StaffRole,200).role=='operator'
    headers={'X-Telegram-Init-Data':signed_init_data(100)}
    with TestClient(app) as client:
        assert client.put('/api/miniapp/admin/staff/100/role',headers=headers,json={'role':'operator'}).status_code==409
        assert client.put('/api/miniapp/admin/staff/200/role',headers=headers,json={'role':'manager'}).status_code==200


def test_signer_change_rejects_stale_snapshot(monkeypatch):
    configure(monkeypatch)
    set_trusted_signer(100,200,'Первый',True)
    before={'full_name':'Первый','active':True}
    set_trusted_signer(100,200,'Второй',False)
    with pytest.raises(Conflict,match='изменились'):set_trusted_signer(100,200,'Устаревший',True,before)
    with Session() as session:assert session.get(TrustedSigner,200).full_name=='Второй'


def test_chat_reminders_updates_same_profile(monkeypatch):
    configure(monkeypatch);monkeypatch.setattr(settings,'private',lambda _:True)
    monkeypatch.setattr(settings,'reminder_menu',AsyncMock())
    query=SimpleNamespace(data='rem:set:off',from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(settings.reminder_action(query))
    assert profile_state(42)['reminders_enabled'] is False
