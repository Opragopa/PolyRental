import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import chat_workflows as cw
from app.db import BookingHandover, Session
from app.handover import handover_state
from app.rental import transition
from tests.test_completion_workflows import ready_booking


class MemoryState:
    def __init__(self): self.data={};self.state=None
    async def get_data(self): return dict(self.data)
    async def get_state(self): return self.state
    async def update_data(self, **values): self.data.update(values)
    async def set_state(self, value): self.state=value.state
    async def clear(self): self.data={};self.state=None


def test_partial_receipt_requires_fresh_read_and_records_ack(monkeypatch):
    monkeypatch.setattr(cw,'private',lambda _:True)
    booking_id=ready_booking(monkeypatch,partial=True)
    transition(booking_id,'ready',100)
    state=MemoryState(); message=SimpleNamespace(answer=AsyncMock())
    query=SimpleNamespace(data=f'cw:askattest:{booking_id}:received',from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=message)
    asyncio.run(cw.customer_action(query,state))
    nonce=state.data['receipt_nonce']
    assert state.data['receipt_partial'] is True
    with Session.begin() as session:
        row=session.get(BookingHandover,booking_id)
        data=dict(row.data);data['exceptions']=[dict(data['exceptions'][0],note='Обновлено')];row.data=data
    query.data=f'cw:receiptconfirm:{booking_id}:{nonce}'
    asyncio.run(cw.customer_action(query,state))
    assert query.answer.call_args.kwargs['show_alert']
    assert not handover_state(booking_id).get('received_at')
    query.data=f'cw:askattest:{booking_id}:received';asyncio.run(cw.customer_action(query,state))
    query.data=f"cw:receiptconfirm:{booking_id}:{state.data['receipt_nonce']}";asyncio.run(cw.customer_action(query,state))
    assert handover_state(booking_id)['exceptions_acknowledged'] is True


def test_chat_dispute_applies_once(monkeypatch):
    from datetime import timedelta
    from app.booking_changes import propose_change,change_view
    from app.rental import get_booking
    from tests.test_miniapp import configure
    from tests.test_operation_lease import pending_booking
    monkeypatch.setattr(cw,'private',lambda _:True);configure(monkeypatch)
    booking_id=pending_booking();booking=get_booking(booking_id)
    proposal={'start':(booking.starts_at+timedelta(days=1)).isoformat(),'end':(booking.ends_at+timedelta(days=1)).isoformat(),'lines':[{'article_id':line.article_id,'quantity':line.quantity} for line in booking.lines]}
    change_id=propose_change(booking_id,100,'manager_edit','Проверьте сроки',proposal)
    state=MemoryState();message=SimpleNamespace(answer=AsyncMock());user=SimpleNamespace(id=42)
    query=SimpleNamespace(data=f'cw:dispute:{booking_id}:{change_id}',from_user=user,answer=AsyncMock(),message=message)
    asyncio.run(cw.customer_action(query,state))
    asyncio.run(cw.customer_dispute_comment(SimpleNamespace(text='Даты не подходят',from_user=user,answer=AsyncMock()),state))
    query.data=f"cw:disputesave:{booking_id}:{state.data['dispute_nonce']}"
    asyncio.run(cw.customer_action(query,state));asyncio.run(cw.customer_action(query,state))
    assert change_view(booking_id,42)['status']=='disputed'
    assert query.answer.call_args.kwargs['show_alert']


def test_customer_fix_checks_snapshot_and_preserves_newer_changes(monkeypatch):
    from datetime import timedelta
    from app.booking_changes import change_view,propose_change
    from app.db import Booking
    from app.rental import get_booking
    from tests.test_miniapp import configure
    from tests.test_operation_lease import pending_booking
    monkeypatch.setattr(cw,'private',lambda _:True);configure(monkeypatch)
    booking_id=pending_booking();change_id=propose_change(booking_id,100,'client_fix','Уточните состав')
    state=MemoryState();user=SimpleNamespace(id=42);message=SimpleNamespace(answer=AsyncMock())
    query=SimpleNamespace(data=f'cw:fix:{booking_id}:{change_id}',from_user=user,answer=AsyncMock(),message=message)
    async def prepare():
        await cw.customer_action(query,state)
        await cw.customer_edit_dates(SimpleNamespace(text='−',from_user=user,answer=AsyncMock()),state)
        await cw.customer_edit_lines(SimpleNamespace(text='−',from_user=user,answer=AsyncMock()),state)
    asyncio.run(prepare());nonce=state.data['customer_edit_nonce']
    with Session.begin() as session:
        booking=session.get(Booking,booking_id);booking.starts_at+=timedelta(days=1);booking.ends_at+=timedelta(days=1)
    changed_start=get_booking(booking_id).starts_at
    query.data=f'cw:editsave:{booking_id}:{nonce}';asyncio.run(cw.customer_action(query,state))
    assert query.answer.call_args.kwargs['show_alert']
    assert get_booking(booking_id).starts_at==changed_start
    assert change_view(booking_id,42)['status']=='pending'
    query.data=f'cw:fix:{booking_id}:{change_id}';asyncio.run(prepare())
    query.data=f"cw:editsave:{booking_id}:{state.data['customer_edit_nonce']}";asyncio.run(cw.customer_action(query,state))
    assert change_view(booking_id,42)['status']=='accepted'
    assert get_booking(booking_id).status=='pending'
