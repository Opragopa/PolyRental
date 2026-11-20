import asyncio
import hashlib
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import bot
from app.client_profile import booking_identity
from app.miniapp import require_customer
from app.miniapp_server import app
from app.pii import consent_text, sanitize_image, submit_identity, validate_identity_payload, IdentityFieldError
from app.rental import availability, get_booking, now, save_equipment, transition
from tests.test_chat_customer_integration import MemoryState
from tests.test_miniapp import configure, image_bytes


def payload():
    start = now() + timedelta(days=4, hours=3)
    end = start + timedelta(hours=2)
    article_id = availability(start, end)[0]['id']
    return {'request_id':str(uuid4()), 'start':start.isoformat(), 'end':end.isoformat(),
            'lines':[{'article_id':article_id, 'quantity':1}]}


@pytest.mark.parametrize('username,expected', [('focus_group','@focus_group'), (None,'Анна')])
def test_new_customer_books_without_name_or_phone(monkeypatch, username, expected):
    configure(monkeypatch)
    user = {'id':42, 'first_name':'Анна', 'username':username}
    monkeypatch.setitem(app.dependency_overrides, require_customer, lambda:user)
    save_equipment('NEW-CAM', 'Камера', '', 0, 'available')
    with TestClient(app) as client:
        next_payload = payload()
        next_payload['start'] = (now() + timedelta(days=14)).isoformat()
        next_payload['end'] = (now() + timedelta(days=15)).isoformat()
        response = client.post('/api/miniapp/bookings', json=next_payload)
        assert response.status_code == 201, response.text
        result = response.json()
        assert result['customer_name'] == expected
        assert result['customer_contact'] == ('@focus_group' if username else 'tg://user?id=42')
        assert result['identity_status'] == 'not_required'


def test_form_updates_booking_and_next_booking_uses_full_name(monkeypatch):
    configure(monkeypatch)
    user = {'id':42, 'username':'focus_group'}
    monkeypatch.setitem(app.dependency_overrides, require_customer, lambda:user)
    save_equipment('FORM-CAM', 'Камера', '', 0, 'available')
    with TestClient(app) as client:
        booking_id = client.post('/api/miniapp/bookings', json=payload()).json()['id']
        transition(booking_id, 'confirmed', 100)
        fields = {'full_name':'Анна Иванова', 'phone':'+7 (999) 123-45-67', 'birth_date':'2000-01-01',
                  'passport_series':'4510', 'passport_number':'123456', 'passport_issued_at':'2020-01-01',
                  'passport_issuer':'Тестовый отдел', 'passport_division_code':'770-001',
                  'registration_address':'Тестовый адрес', 'residential_address':'Тестовый адрес'}
        documents = {kind:sanitize_image(image_bytes(), 'image/png') for kind in
                     ('passport_main','passport_registration','student_front')}
        submit_identity(booking_id,42,fields,documents,'test-v1',hashlib.sha256(consent_text().encode()).hexdigest())
        booking = get_booking(booking_id)
        assert booking.customer_name == fields['full_name']
        assert booking.customer_contact.startswith('+7')
        assert booking_identity(user)[0] == fields['full_name']
        assert booking_identity({'id':43, 'username':'different_customer'})[0] == '@different_customer'
        next_payload = payload()
        next_payload['start'] = (now() + timedelta(days=14)).isoformat()
        next_payload['end'] = (now() + timedelta(days=15)).isoformat()
        response = client.post('/api/miniapp/bookings', json=next_payload)
        assert response.status_code == 201, response.text
        assert response.json()['customer_name'] == fields['full_name']


@pytest.mark.parametrize('phone', ['', 'abc', '@username', '+123', None])
def test_identity_requires_real_phone(phone):
    with pytest.raises(IdentityFieldError) as caught:
        validate_identity_payload({'full_name':'Анна Иванова', 'phone':phone, 'birth_date':'2000-01-01',
            'passport_series':'4510','passport_number':'123456','passport_issued_at':'2020-01-01',
            'passport_issuer':'Тест','passport_division_code':'770-001','registration_address':'Адрес',
            'residential_address':'Адрес'}, require_phone=True)
    assert caught.value.field == 'phone'


def test_text_booking_skips_name_and_phone(monkeypatch):
    from app import client_profile
    monkeypatch.setattr(client_profile, 'booking_identity', lambda user:('@focus_group','@focus_group'))
    monkeypatch.setattr(bot, 'get_booking_settings', lambda: {'rental_purpose_enabled': False})
    review = AsyncMock(); monkeypatch.setattr(bot,'show_review',review)
    state = MemoryState(); state.data={'ids':[1]}; state.state=bot.Rent.equipment.state
    query = SimpleNamespace(from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(bot.next_equipment(query,state))
    assert state.state == bot.Rent.review.state
    assert state.data['name'] == '@focus_group'
    query.message.answer.assert_not_awaited()
    review.assert_awaited_once()
