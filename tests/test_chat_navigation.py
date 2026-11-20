import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import EditMessageText

from app import chat_workflows as chat
from app.inventory import save_feature
from app.rental import get_booking, transition
from tests.test_chat_customer_integration import MemoryState
from tests.test_completion_workflows import ready_booking


def message():
    return SimpleNamespace(message_id=57, chat=SimpleNamespace(id=42, type='private'),
        answer=AsyncMock(), edit_text=AsyncMock(), edit_reply_markup=AsyncMock())


def bad_request(detail):
    return TelegramBadRequest(method=EditMessageText(chat_id=42,message_id=57,text='screen'),message=detail)


def test_features_booking_and_list_reuse_the_same_message(monkeypatch):
    monkeypatch.setattr(chat,'private',lambda _:True)
    booking_id=ready_booking(monkeypatch)
    asset=get_booking(booking_id).assets[0].equipment_id
    save_feature(asset,'Царапина <не HTML> & особенность',100)
    transition(booking_id,'ready',100)
    target=message();state=MemoryState()
    query=SimpleNamespace(data='',message=target,from_user=SimpleNamespace(id=42),answer=AsyncMock())
    async def navigate():
        await chat.show_customer_booking(target,booking_id,42)
        for callback in [f'cw:equipment:{booking_id}:0',f'cw:open:{booking_id}','cw:page:0']:
            query.data=callback
            await chat.customer_action(query,state)
    asyncio.run(navigate())
    assert target.answer.await_count==1, 'only the initial command creates a message'
    assert target.edit_text.await_count==3
    features=target.edit_text.call_args_list[0]
    assert 'Царапина <не HTML> & особенность' in features.args[0]
    assert features.kwargs['parse_mode'] is None
    assert features.kwargs['reply_markup'].inline_keyboard[-1][0].callback_data==f'cw:open:{booking_id}'
    assert 'Заявка' in target.edit_text.call_args_list[1].args[0]
    assert 'Ваши заявки' in target.edit_text.call_args_list[2].args[0]
    target.edit_reply_markup.assert_not_awaited()


def test_feature_pagination_does_not_send_another_message(monkeypatch):
    monkeypatch.setattr(chat,'private',lambda _:True)
    booking_id=ready_booking(monkeypatch)
    asset=get_booking(booking_id).assets[0].equipment_id
    for i in range(3): save_feature(asset,f'Особенность {i} '+('а'*1800),100)
    transition(booking_id,'ready',100)
    target=message();query=SimpleNamespace(data='',message=target,from_user=SimpleNamespace(id=42),answer=AsyncMock())
    async def walk():
        for page in [0,1,0]:
            query.data=f'cw:equipment:{booking_id}:{page}'
            await chat.customer_action(query,MemoryState())
    asyncio.run(walk())
    assert target.edit_text.await_count==3
    target.answer.assert_not_awaited()
    assert all(len(call.args[0])<4096 for call in target.edit_text.call_args_list)
    assert target.edit_text.call_args_list[0].args[0]!=target.edit_text.call_args_list[1].args[0]


def test_unchanged_screen_is_silent():
    target=message();target.edit_text.side_effect=bad_request('Bad Request: message is not modified')
    asyncio.run(chat.customer_screen(target,'Already here',replace=True))
    target.answer.assert_not_awaited()
    target.edit_reply_markup.assert_not_awaited()


@pytest.mark.parametrize('detail',["Bad Request: message can't be edited",'Bad Request: message to edit not found'])
def test_uneditable_old_message_creates_one_replacement(detail):
    target=message();target.edit_text.side_effect=bad_request(detail)
    asyncio.run(chat.customer_screen(target,'Replacement',replace=True,reply_markup=None))
    target.answer.assert_awaited_once_with('Replacement',parse_mode=None,reply_markup=None)
    target.edit_reply_markup.assert_awaited_once_with(reply_markup=None)


def test_unexpected_telegram_error_is_not_replaced_with_a_duplicate():
    target=message();target.edit_text.side_effect=bad_request('Bad Request: chat not found')
    with pytest.raises(TelegramBadRequest):
        asyncio.run(chat.customer_screen(target,'screen',replace=True))
    target.answer.assert_not_awaited()
