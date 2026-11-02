import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest

from app import bot


def test_chat_quantity_and_limit(monkeypatch):
    item = {'id': 2, 'name':'Объектив', 'available':True, 'available_quantity':2}
    monkeypatch.setattr(bot, 'availability', lambda *_: [item])
    data = {'start': datetime.now(timezone.utc).isoformat(), 'end':datetime.now(timezone.utc).isoformat(), 'quantities':{}, 'ids':[]}
    async def update(**values): data.update(values)
    state = SimpleNamespace(get_state=AsyncMock(return_value=bot.Rent.equipment.state), get_data=AsyncMock(side_effect=lambda:dict(data)), update_data=AsyncMock(side_effect=update))
    query = SimpleNamespace(data='rent:plus:2', answer=AsyncMock(), message=SimpleNamespace(edit_reply_markup=AsyncMock()))
    asyncio.run(bot.change_equipment_quantity(query,state)); asyncio.run(bot.change_equipment_quantity(query,state))
    assert data['quantities'] == {'2':2} and data['ids'] == [2]
    asyncio.run(bot.change_equipment_quantity(query,state))
    assert data['quantities'] == {'2':2}
    assert query.answer.call_args.kwargs['show_alert']
    query.data='rent:minus:2'; asyncio.run(bot.change_equipment_quantity(query,state))
    assert data['quantities'] == {'2':1}


def test_book_chat_starts_chat_flow(monkeypatch):
    begin = AsyncMock(); monkeypatch.setattr(bot, 'begin_chat_booking', begin)
    message, state = object(), object()
    asyncio.run(bot.book_chat(message,state))
    begin.assert_awaited_once_with(message,state)


def test_flexible_dates_and_invalid_input():
    assert bot.parse_time('15.11.2028 9:30').hour == 9
    assert bot.parse_time('завтра 10').hour == 10
    assert bot.parse_time('завтра 15:00').hour == 15
    assert bot.parse_time('15.11 14:30').minute == 30
    with pytest.raises(ValueError): bot.parse_time('несуществующая дата')


def test_orphaned_date_explains_restart():
    message = SimpleNamespace(chat=SimpleNamespace(type='private'), answer=AsyncMock())
    state = SimpleNamespace(get_state=AsyncMock(return_value=None))
    asyncio.run(bot.orphaned_booking_date(message, state))
    assert 'перезапускался' in message.answer.call_args.args[0]


def test_selection_shows_full_name_and_quantity(monkeypatch):
    title = 'Длинное название камеры, которое не помещается в кнопку Telegram'
    monkeypatch.setattr(bot, 'availability', lambda *_: [{'id': 2, 'name': title, 'available_quantity': 3}])
    data = {'start': datetime.now(timezone.utc).isoformat(), 'end': datetime.now(timezone.utc).isoformat(), 'quantities': {'2': 2}}
    state = SimpleNamespace(get_state=AsyncMock(return_value=bot.Rent.equipment.state), get_data=AsyncMock(return_value=data))
    query = SimpleNamespace(answer=AsyncMock(), message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(bot.show_selection(query, state))
    assert title + ' × 2' in query.message.answer.call_args.args[0]


def test_cancel_confirmation_keeps_draft_until_yes():
    data = {}
    async def update(**values): data.update(values)
    state = SimpleNamespace(get_state=AsyncMock(return_value=bot.Rent.review.state), get_data=AsyncMock(side_effect=lambda:dict(data)), update_data=AsyncMock(side_effect=update), clear=AsyncMock())
    message = SimpleNamespace(answer=AsyncMock())
    asyncio.run(bot.cancel_flow(message, state))
    state.clear.assert_not_awaited()
    nonce = data['cancel_nonce']
    q = SimpleNamespace(data=f'rent:cancel:no:{nonce}', answer=AsyncMock(), message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(bot.confirm_cancel_flow(q, state)); state.clear.assert_not_awaited()
    q.data = f'rent:cancel:yes:{nonce}'
    asyncio.run(bot.confirm_cancel_flow(q, state)); state.clear.assert_not_awaited()
    asyncio.run(bot.cancel_flow(message, state))
    q.data = f"rent:cancel:yes:{data['cancel_nonce']}"
    asyncio.run(bot.confirm_cancel_flow(q, state)); state.clear.assert_awaited_once()


def test_date_edit_returns_to_review_with_saved_selection(monkeypatch):
    selected = {'2': 2}
    data = {'start': bot.parse_time('15.11.2028 10:00').isoformat(), 'editing': 'start', 'name': 'QA', 'contact': '@qa', 'ids': [2], 'quantities': selected}
    monkeypatch.setattr(bot, 'availability', lambda *_: [{'id': 2, 'name': 'Камера', 'available': True, 'available_quantity': 3}])
    review = AsyncMock(); monkeypatch.setattr(bot, 'show_review', review)
    async def update(**values): data.update(values)
    state = SimpleNamespace(get_data=AsyncMock(side_effect=lambda: dict(data)), update_data=AsyncMock(side_effect=update), set_state=AsyncMock())
    message = SimpleNamespace(text='16.11.2028 17:00', answer=AsyncMock())
    asyncio.run(bot.rental_end(message, state))
    assert data['quantities'] == selected
    state.set_state.assert_awaited_with(bot.Rent.review)
    review.assert_awaited_once()
