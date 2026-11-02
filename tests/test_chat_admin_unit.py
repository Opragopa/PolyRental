import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from app import chat_admin as admin


def test_non_admin_cannot_open_hidden_tests(monkeypatch):
    monkeypatch.setattr(admin,'private',lambda _:True)
    monkeypatch.setattr(admin,'staff_allows',lambda _actor,role:role=='operator')
    query=SimpleNamespace(data='am:hidden:0',from_user=SimpleNamespace(id=200),answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(admin.moderation_action(query,SimpleNamespace()))
    assert query.answer.call_args.kwargs['show_alert']


def test_hide_requires_test_flag(monkeypatch):
    monkeypatch.setattr(admin,'private',lambda _:True)
    monkeypatch.setattr(admin,'staff_allows',lambda *_:True)
    monkeypatch.setattr(admin,'get_booking',lambda _:SimpleNamespace(is_test=False))
    state=SimpleNamespace(clear=AsyncMock(),update_data=AsyncMock())
    query=SimpleNamespace(data='am:hide:5',from_user=SimpleNamespace(id=100),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(admin.moderation_action(query,state))
    state.clear.assert_not_awaited();assert query.answer.call_args.kwargs['show_alert']


def test_stale_confirmation_cannot_change_flag(monkeypatch):
    from app import rental
    monkeypatch.setattr(admin,'staff_allows',lambda *_:True)
    write=AsyncMock();monkeypatch.setattr(rental,'set_booking_test_flag',write)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'moderation_nonce':'new'}),get_state=AsyncMock(return_value=admin.Moderation.confirm.state))
    query=SimpleNamespace(from_user=SimpleNamespace(id=100))
    with pytest.raises(admin.Conflict):asyncio.run(admin.moderation_save(query,state,'old'))
    write.assert_not_called()
