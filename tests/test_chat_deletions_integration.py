import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import select

from app import chat_deletions as chat
from app.db import Audit, Booking, DeletionIntent, Session
from app.rental import assign_booking_assets, create_booking, expire_deletion_intents, get_booking, now, transition
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking


class MemoryState:
    def __init__(self, data=None):
        self.data = data or {}
        self.state = chat.DeletionDraft.confirm.state if data else None

    async def get_data(self): return dict(self.data)
    async def get_state(self): return self.state
    async def clear(self): self.data, self.state = {}, None
    async def update_data(self, **data): self.data.update(data)
    async def set_state(self, state): self.state = state.state


def query(data, actor=100):
    return SimpleNamespace(data=data, from_user=SimpleNamespace(id=actor), answer=AsyncMock(),
                           message=SimpleNamespace(answer=AsyncMock()))


def run_action(q, state):
    asyncio.run(chat.deletion_action(q, state))


def schedule(monkeypatch, booking_id, kind, target=None, actor=100):
    monkeypatch.setattr(chat, 'private', lambda _: True)
    state = MemoryState()
    ask = query(f'dl:ask:{kind}:{booking_id}:{target or 0}', actor)
    run_action(ask, state)
    assert state.data.get('delete_intent'), ask.answer.call_args
    intent_id = state.data['delete_intent']
    nonce = state.data['delete_nonce']
    confirm = query(f'dl:prepare:{nonce}', actor)
    run_action(confirm, state)
    assert state.data == {}
    return intent_id, nonce, state


def expire(intent_id):
    with Session.begin() as session:
        session.get(DeletionIntent, intent_id).expires_at = now() - timedelta(seconds=1)
    expire_deletion_intents()


def restore(monkeypatch, booking_id, kind, target=None):
    monkeypatch.setattr(chat, 'private', lambda _: True)
    state = MemoryState(dict(restore_kind=kind, restore_booking=booking_id,
                             restore_target=target, restore_nonce='abc'))
    q = query('dr:save:abc')
    asyncio.run(chat.restore_action(q, state))
    assert q.answer.call_args.args == ('Восстановлено',)
    asyncio.run(chat.restore_action(q, state))
    assert q.answer.call_args.kwargs['show_alert']


def test_chat_undo_is_idempotent_and_stale_confirmation_does_not_repeat(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    line_id = get_booking(booking_id).lines[0].id
    intent_id, nonce, state = schedule(monkeypatch, booking_id, 'line', line_id)
    stale = query(f'dl:prepare:{nonce}')
    run_action(stale, state)
    assert stale.answer.call_args.kwargs['show_alert']
    for _ in range(2):
        run_action(query(f'dl:undo:{booking_id}:{intent_id.replace("-", "")}'), state)
    expire(intent_id)
    assert get_booking(booking_id).lines[0].id == line_id
    with Session() as session:
        actions = session.scalars(select(Audit.action).where(Audit.booking_id == booking_id)).all()
        assert actions.count(f'line_delete_undo:{line_id}') == 1


def test_chat_delete_and_restore_request_and_line(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    line_id = get_booking(booking_id).lines[0].id
    intent_id, _, _ = schedule(monkeypatch, booking_id, 'line', line_id)
    expire(intent_id)
    assert not get_booking(booking_id).lines
    assert (booking_id, 'line', line_id) in chat.deleted_intents(0)
    restore(monkeypatch, booking_id, 'line', line_id)
    assert get_booking(booking_id).lines[0].id == line_id
    assert (booking_id, 'line', line_id) not in chat.deleted_intents(0)
    intent_id, _, _ = schedule(monkeypatch, booking_id, 'request')
    expire(intent_id)
    assert get_booking(booking_id) is None
    assert (booking_id, 'request', None) in chat.deleted_intents(0)
    state = MemoryState()
    choice = query(f'dr:ask:request:{booking_id}:0')
    asyncio.run(chat.restore_select(choice, state))
    confirmation = query(f"dr:save:{state.data['restore_nonce']}")
    asyncio.run(chat.restore_action(confirmation, state))
    assert confirmation.answer.call_args.args == ('Восстановлено',)
    assert get_booking(booking_id) is not None
    assert (booking_id, 'request', None) not in chat.deleted_intents(0)


def test_chat_delete_and_restore_assigned_asset(monkeypatch):
    configure(monkeypatch)
    article_id = article_with_assets('CHAT-DELETE', 2)
    start = now() + timedelta(days=5)
    booking_id = create_booking(42, 'QA', '@qa', start, start + timedelta(hours=1),
                                [{'article_id': article_id, 'quantity': 2}])
    transition(booking_id, 'confirmed', 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = 'verified'
    assign_booking_assets(booking_id, 100)
    asset_id = get_booking(booking_id).assets[0].equipment_id
    monkeypatch.setattr(chat, 'private', lambda _: True)
    listing = SimpleNamespace(answer=AsyncMock())
    asyncio.run(chat.target_list(listing, 100, booking_id, 'asset', 0))
    assert listing.answer.await_count == 1
    intent_id, _, _ = schedule(monkeypatch, booking_id, 'asset', asset_id)
    expire(intent_id)
    assert len(get_booking(booking_id).assets) == 1
    restore(monkeypatch, booking_id, 'asset', asset_id)
    assert len(get_booking(booking_id).assets) == 2


def test_denied_failed_and_foreign_undo(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    intent_id, _, state = schedule(monkeypatch, booking_id, 'request')
    foreign = query(f'dl:undo:{booking_id}:{intent_id.replace("-", "")}', 200)
    run_action(foreign, state)
    assert foreign.answer.call_args.kwargs['show_alert']
    denied = query(f'dl:ask:request:{booking_id}:0', 42)
    run_action(denied, state)
    assert denied.answer.call_args.kwargs['show_alert']
    with Session.begin() as session:
        session.get(DeletionIntent, intent_id).status = 'failed'
    failed = query(f'dl:undo:{booking_id}:{intent_id.replace("-", "")}')
    run_action(failed, state)
    assert failed.answer.call_args.kwargs['show_alert']
    assert 'не выполнено' in failed.answer.call_args.args[0]


def test_network_error_keeps_action_recoverable_without_recreating_intent(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    monkeypatch.setattr(chat, 'private', lambda _: True)
    state = MemoryState()
    run_action(query(f'dl:ask:request:{booking_id}:0'), state)
    nonce, intent_id = state.data['delete_nonce'], state.data['delete_intent']
    original = chat.create_deletion_intent
    def committed_then_disconnected(*args):
        original(*args)
        raise ConnectionError('sensitive diagnostics must not be sent')
    monkeypatch.setattr(chat, 'create_deletion_intent', committed_then_disconnected)
    failure = query(f'dl:prepare:{nonce}')
    run_action(failure, state)
    assert 'проверьте состояние' in failure.answer.call_args.args[0]
    assert 'sensitive' not in failure.answer.call_args.args[0]
    assert state.data['delete_intent'] == intent_id
    monkeypatch.setattr(chat, 'create_deletion_intent', original)
    run_action(query(f'dl:prepare:{nonce}'), state)
    with Session() as session:
        assert len(session.scalars(select(DeletionIntent).where(DeletionIntent.id == intent_id)).all()) == 1
