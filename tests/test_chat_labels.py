import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import chat_workflows as chat
from app.chat_labels import BOOKING_STATUSES, SUPPORT_STATUSES


@pytest.mark.parametrize('status,label', BOOKING_STATUSES.items())
def test_customer_booking_buttons_use_russian_and_keep_callback(monkeypatch, status, label):
    monkeypatch.setattr(chat, 'customer_history_page', lambda *args: ([SimpleNamespace(id=42, human_number='TC42', status=status)], 1))
    message = SimpleNamespace(answer=AsyncMock())
    asyncio.run(chat.customer_list(message, 7))
    button = message.answer.call_args.kwargs['reply_markup'].inline_keyboard[0][0]
    assert button.text == f'TC42 · {label}'
    assert button.callback_data == 'cw:open:42'


@pytest.mark.parametrize('status,label', SUPPORT_STATUSES.items())
def test_staff_support_buttons_and_details_use_russian(monkeypatch, status, label):
    from app import support
    row = {'id':42, 'request_number':'TC42', 'status':status, 'owner_id':None}
    monkeypatch.setattr(chat, 'staff_allows', lambda *args: True)
    monkeypatch.setattr(support, 'list_threads', lambda **kwargs: [row])
    message = SimpleNamespace(answer=AsyncMock())
    asyncio.run(chat.staff_support_list(message, 7, 0))
    button = message.answer.call_args.kwargs['reply_markup'].inline_keyboard[0][0]
    assert button.text.endswith(label)
    asyncio.run(chat.support_detail(message, 7, 42))
    assert f'Статус: {label}' in message.answer.call_args.args[0]


def test_russian_catalog_fields_and_values_keep_technical_contract():
    from app.chat_catalog import ASSET_FIELDS, ARTICLE_FIELDS, parse_editor_values, editor_payload
    updates = parse_editor_values('состояние=на ремонте\nзаряд=80', ASSET_FIELDS)
    assert updates == {'condition':'на ремонте', 'charge':'80'}
    result = editor_payload('equipment', {'article_id':1, 'condition':'available'}, updates)
    assert result['condition'] == 'maintenance'
    assert result['charge'] == 80
    assert parse_editor_values('название=Камера\nпрофиль проверки=камеры', ARTICLE_FIELDS) == {'name':'Камера', 'inspection_profile':'камеры'}
    with pytest.raises(ValueError):
        parse_editor_values('название=Камера\nname=Дубль', ARTICLE_FIELDS)
