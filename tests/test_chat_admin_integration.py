import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest

from app import chat_admin as admin
from app.client_profile import profile_state,set_client_block
from app.rental import Conflict,get_booking,list_hidden_test_bookings,set_booking_test_flag
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking


class MemoryState:
    def __init__(self,data):self.data=dict(data);self.state=admin.Moderation.confirm.state
    async def get_data(self):return dict(self.data)
    async def get_state(self):return self.state
    async def clear(self):self.data={};self.state=None


def query(actor=100):return SimpleNamespace(from_user=SimpleNamespace(id=actor),answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))


def test_chat_test_flag_hide_and_admin_restore(monkeypatch):
    configure(monkeypatch);booking_id=pending_booking()
    state=MemoryState({'moderation_operation':'flag','moderation_target':booking_id,'moderation_before':False,'moderation_nonce':'a'})
    asyncio.run(admin.moderation_save(query(),state,'a'))
    assert get_booking(booking_id).is_test
    state=MemoryState({'moderation_operation':'hide','moderation_target':booking_id,'moderation_before':True,'moderation_nonce':'b'})
    asyncio.run(admin.moderation_save(query(200),state,'b'))
    assert get_booking(booking_id) is None
    assert [row.id for row in list_hidden_test_bookings()]==[booking_id]
    state=MemoryState({'moderation_operation':'restore','moderation_target':booking_id,'moderation_before':None,'moderation_nonce':'c'})
    asyncio.run(admin.moderation_save(query(),state,'c'))
    assert get_booking(booking_id).is_test


def test_stale_test_flag_and_block_conflicts(monkeypatch):
    configure(monkeypatch);booking_id=pending_booking()
    set_booking_test_flag(booking_id,100,True)
    with pytest.raises(Conflict,match='отметка изменилась'):set_booking_test_flag(booking_id,100,True,False)
    set_client_block(42,100,True)
    with pytest.raises(Conflict,match='Ограничение клиента изменилось'):set_client_block(42,100,True,False)
    assert profile_state(42)['client_allowed'] is False

