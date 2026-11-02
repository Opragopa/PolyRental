import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest

from app import chat_settings as settings


def test_reminder_button_only_updates_clicking_user(monkeypatch):
    monkeypatch.setattr(settings,'private',lambda _:True)
    changed=[];monkeypatch.setattr(settings,'set_reminders_enabled',lambda *args:changed.append(args))
    monkeypatch.setattr(settings,'reminder_menu',AsyncMock())
    query=SimpleNamespace(data='rem:set:off',from_user=SimpleNamespace(id=45),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(settings.reminder_action(query))
    assert changed==[(45,False)]


def test_staff_action_rejects_revoked_admin(monkeypatch):
    monkeypatch.setattr(settings,'private',lambda _:True)
    monkeypatch.setattr(settings,'staff_allows',lambda *_:False)
    query=SimpleNamespace(data='as:role:200:admin',from_user=SimpleNamespace(id=100),answer=AsyncMock())
    asyncio.run(settings.admin_action(query,SimpleNamespace()))
    assert query.answer.call_args.kwargs['show_alert']


def test_staff_save_rejects_stale_confirmation(monkeypatch):
    monkeypatch.setattr(settings,'staff_allows',lambda *_:True)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'settings_nonce':'new'}),get_state=AsyncMock(return_value=settings.AdminSettings.confirm.state))
    query=SimpleNamespace(from_user=SimpleNamespace(id=100))
    with pytest.raises(settings.Conflict):asyncio.run(settings.admin_save(query,state,'old'))


def test_signer_input_rejects_invalid_status(monkeypatch):
    monkeypatch.setattr(settings,'private',lambda _:True)
    monkeypatch.setattr(settings,'staff_allows',lambda *_:True)
    state=SimpleNamespace(update_data=AsyncMock(),set_state=AsyncMock())
    message=SimpleNamespace(text='Иванов | возможно',from_user=SimpleNamespace(id=100),answer=AsyncMock())
    asyncio.run(settings.signer_input(message,state))
    state.update_data.assert_not_awaited()
