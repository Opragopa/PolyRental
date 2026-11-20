import asyncio
import importlib.util
import json
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app import bot, chat_workflows
from app.booking_settings import get_booking_settings, save_booking_settings
from app.db import Booking, BookingSettings, Session, engine
from app.miniapp_server import app
from app.rental import create_booking, get_booking, now
from tests.test_chat_customer_integration import MemoryState
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def headers(uid=42):
    return {'X-Telegram-Init-Data': signed_init_data(uid)}


def payload():
    article = article_with_assets('PURPOSE', 1)
    start = now() + timedelta(days=5)
    return {'request_id': str(uuid4()), 'start': start.isoformat(),
            'end': (start + timedelta(hours=2)).isoformat(),
            'lines': [{'article_id': article, 'quantity': 1}]}


@pytest.mark.parametrize('purpose,expected', [(None, ''), ('', ''), ('   ', ''),
    ('  Съёмка <интервью> & мероприятия\nв студии  ', 'Съёмка <интервью> & мероприятия\nв студии'),
    ('я' * 2000, 'я' * 2000)], ids=['omitted', 'empty', 'spaces', 'text', 'limit'])
def test_create_purpose_and_owned_cards(monkeypatch, purpose, expected):
    configure(monkeypatch)
    data = payload()
    if purpose is not None:
        data['rental_purpose'] = purpose
    with TestClient(app) as client:
        response = client.post('/api/miniapp/bookings', json=data, headers=headers())
        assert response.status_code == 201, response.text
        booking_id = response.json()['id']
        assert response.json()['rental_purpose'] == expected
        assert get_booking(booking_id).rental_purpose == expected
        assert client.get(f'/api/miniapp/bookings/{booking_id}', headers=headers()).json()['rental_purpose'] == expected
        staff_response = client.get('/api/miniapp/admin/bookings', headers=headers(100))
        assert staff_response.status_code == 200, staff_response.text
        assert next(row for row in staff_response.json()['items'] if row['id'] == booking_id)['rental_purpose'] == expected
        assert client.get(f'/api/miniapp/bookings/{booking_id}', headers=headers(43)).status_code == 404
        data['rental_purpose'] = 'Другой ответ'
        repeated = client.post('/api/miniapp/bookings', json=data, headers=headers()).json()
        assert repeated['id'] == booking_id and repeated['rental_purpose'] == expected


def test_limit_and_disabled_question_still_accepts_answer(monkeypatch):
    configure(monkeypatch)
    data = payload()
    with TestClient(app) as client:
        data['rental_purpose'] = 'x' * 2001
        assert client.post('/api/miniapp/bookings', json=data, headers=headers()).status_code == 422
        with pytest.raises(ValueError, match='2000'):
            create_booking(42, 'QA', '@qa', now() + timedelta(days=5), now() + timedelta(days=6),
                           data['lines'], rental_purpose='x' * 2001)
        save_booking_settings(100, False)
        data['rental_purpose'] = 'Уже введённый ответ'
        response = client.post('/api/miniapp/bookings', json=data, headers=headers())
        assert response.status_code == 201
        assert response.json()['rental_purpose'] == data['rental_purpose']
        assert get_booking_settings() == {'rental_purpose_enabled': False}


def test_settings_permissions_and_persistence(monkeypatch):
    configure(monkeypatch)
    from app.db import StaffRole
    with Session.begin() as session:
        session.merge(StaffRole(telegram_id=300, role='operator'))
    monkeypatch.setenv('ADMIN_IDS', '100,200,300')
    with TestClient(app) as client:
        url = '/api/miniapp/admin/booking-settings'
        assert client.get('/api/miniapp/booking-settings').json() == {'rental_purpose_enabled': True}
        for uid in (42, 200, 300):
            assert client.get(url, headers=headers(uid)).status_code == 403
            assert client.put(url, headers=headers(uid), json={'rental_purpose_enabled': False}).status_code == 403
        assert client.put(url, headers=headers(100), json={'rental_purpose_enabled': 'false'}).status_code == 422
        for enabled in (False, True):
            result = client.put(url, headers=headers(100), json={'rental_purpose_enabled': enabled})
            assert result.status_code == 200
            with Session() as session:
                assert session.get(BookingSettings, 1).rental_purpose_enabled is enabled
            assert client.get('/api/miniapp/booking-settings').json() == {'rental_purpose_enabled': enabled}


def test_chat_question_skip_edit_back_and_validation(monkeypatch):
    state = MemoryState()
    state.data = {'ids': [1], 'rental_purpose': 'Старый ответ'}
    message = SimpleNamespace(text='  Интервью  ', answer=AsyncMock())
    monkeypatch.setattr(bot, 'show_review', AsyncMock())
    monkeypatch.setattr(bot, 'get_booking_settings', lambda: {'rental_purpose_enabled': True})
    asyncio.run(bot.review_or_ask_purpose(message, state))
    assert state.state == bot.Rent.purpose.state
    assert 'Пропустить' in str(message.answer.call_args.kwargs['reply_markup'])
    message.text = 'x' * 2001
    asyncio.run(bot.rental_purpose_input(message, state))
    assert state.state == bot.Rent.purpose.state
    assert state.data['rental_purpose'] == 'Старый ответ'
    message.text = '  Интервью  '
    asyncio.run(bot.rental_purpose_input(message, state))
    assert state.state == bot.Rent.review.state and state.data['rental_purpose'] == 'Интервью'
    asyncio.run(bot.back_flow(message, state))
    assert state.state == bot.Rent.purpose.state
    message.text = 'Пропустить'
    asyncio.run(bot.rental_purpose_input(message, state))
    assert state.state == bot.Rent.review.state and state.data['rental_purpose'] == ''
    query = SimpleNamespace(data='rent:edit:purpose', answer=AsyncMock(), message=message)
    asyncio.run(bot.edit_booking_step(query, state))
    assert state.state == bot.Rent.purpose.state
    monkeypatch.setattr(bot, 'get_booking_settings', lambda: {'rental_purpose_enabled': False})
    state.data.pop('purpose_answered')
    asyncio.run(bot.review_or_ask_purpose(message, state))
    assert state.state == bot.Rent.review.state


def test_chat_confirmation_and_webapp_carry_purpose(monkeypatch):
    configure(monkeypatch)
    data = payload()
    state = MemoryState()
    state.state = bot.Rent.review.state
    state.data = {**data, 'name': 'QA', 'contact': '@qa', 'ids': [data['lines'][0]['article_id']],
                  'confirmation_nonce': 'current', 'rental_purpose': 'Интервью'}
    query = SimpleNamespace(data='rent:confirm:current', from_user=SimpleNamespace(id=42),
                            answer=AsyncMock(), message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(bot.confirm_booking(query, state, AsyncMock()))
    with Session() as session:
        booking = session.scalar(select(Booking).where(Booking.client_request_id == data['request_id']))
        assert booking.rental_purpose == 'Интервью'
        booking_id = booking.id
    assert state.data == {}
    message = SimpleNamespace(chat=SimpleNamespace(type='private'),
        from_user=SimpleNamespace(id=43, first_name='QA', last_name=None, username='qa_user'),
        web_app_data=SimpleNamespace(data=json.dumps({**data, 'rental_purpose': 'Мероприятие'})), answer=AsyncMock())
    asyncio.run(bot.booking_from_miniapp(message, AsyncMock()))
    with Session() as session:
        booking = session.scalar(select(Booking).where(Booking.customer_id == 43))
        assert booking.rental_purpose == 'Мероприятие'
    assert get_booking(booking_id).rental_purpose == 'Интервью'


def test_chat_cards_escape_answer_and_keep_after_disable(monkeypatch):
    configure(monkeypatch)
    data = payload()
    purpose = '<b>Интервью</b> & съёмка'
    booking_id = create_booking(42, 'QA', '@qa', now() + timedelta(days=5), now() + timedelta(days=6),
                               data['lines'], rental_purpose=purpose)
    save_booking_settings(100, False)
    for callback, actor in ((chat_workflows.show_customer_booking, 42), (chat_workflows.show_staff_booking, 100)):
        message = SimpleNamespace(answer=AsyncMock())
        asyncio.run(callback(message, booking_id, actor))
        assert '&lt;b&gt;Интервью&lt;/b&gt; &amp; съёмка' in message.answer.call_args.args[0]


def test_migration_preserves_existing_bookings(monkeypatch):
    path = Path(__file__).parents[1] / 'alembic/versions/20261113_47_rental_purpose.py'
    spec = importlib.util.spec_from_file_location('purpose_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    # Exercise the real SQL against isolated tables, with the entire schema rolled back.
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text('CREATE SCHEMA purpose_migration_test'))
            connection.execute(text('SET LOCAL search_path TO purpose_migration_test'))
            connection.execute(text('CREATE TABLE bookings (id INTEGER PRIMARY KEY)'))
            connection.execute(text('INSERT INTO bookings VALUES (1)'))
            monkeypatch.setattr(migration.op, 'execute', lambda sql: connection.execute(text(sql)))
            migration.upgrade()
            migration.upgrade()
            assert connection.execute(text('SELECT rental_purpose FROM bookings WHERE id=1')).scalar_one() == ''
            connection.execute(text('INSERT INTO booking_settings(id) VALUES (1)'))
            assert connection.execute(text('SELECT rental_purpose_enabled FROM booking_settings')).scalar_one() is True
            migration.downgrade()
            assert connection.execute(text('SELECT id FROM bookings')).scalar_one() == 1
        finally:
            transaction.rollback()
