import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import chat_inventory as inventory


def test_owner_edit_requires_manager(monkeypatch):
    monkeypatch.setattr(inventory,'staff_allows',lambda _actor,role: role=='operator')
    query=SimpleNamespace(from_user=SimpleNamespace(id=1),answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    state=SimpleNamespace(clear=AsyncMock(),update_data=AsyncMock(),set_state=AsyncMock())
    import pytest
    with pytest.raises(PermissionError): asyncio.run(inventory.begin_edit(query,state,7,'owner',before={}))
    state.clear.assert_not_awaited()


def test_block_input_rejects_reverse_interval(monkeypatch):
    monkeypatch.setattr(inventory,'private',lambda _:True)
    monkeypatch.setattr(inventory,'staff_allows',lambda *_:True)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'operation':'block'}),update_data=AsyncMock())
    message=SimpleNamespace(text='02.12.2026 12:00 | 01.12.2026 12:00 | тест',from_user=SimpleNamespace(id=1),answer=AsyncMock())
    asyncio.run(inventory.inventory_input(message,state))
    state.update_data.assert_not_awaited();assert 'Проверьте сроки' in message.answer.call_args.args[0]


def test_inventory_save_rejects_stale_nonce(monkeypatch):
    monkeypatch.setattr(inventory,'staff_allows',lambda *_:True)
    save=AsyncMock();monkeypatch.setattr(inventory,'save_owner',save)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'inventory_nonce':'new'}),get_state=AsyncMock(return_value=inventory.InventoryEdit.confirm.state))
    query=SimpleNamespace(from_user=SimpleNamespace(id=99))
    import pytest
    with pytest.raises(inventory.Conflict): asyncio.run(inventory.inventory_save(query,state,'old'))
    save.assert_not_called()
