from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import NotificationDelivery, Session, SupportMessage, SupportThread
from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def test_inbox_is_private_paginated_and_persists_read_state(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        session.execute(text("DELETE FROM notification_inbox_reads WHERE recipient_id IN (442,443)"))
        session.execute(text("DELETE FROM notification_inbox_users WHERE recipient_id IN (442,443)"))
        session.add(NotificationDelivery(recipient_id=442, event='old', message='Старое'))
    headers = {"X-Telegram-Init-Data": signed_init_data(442)}
    other = {"X-Telegram-Init-Data": signed_init_data(443)}
    with TestClient(app) as client:
        first = client.get('/api/miniapp/notifications/inbox', headers=headers).json()
        assert first['unread'] is False
        with Session.begin() as session:
            session.execute(text("UPDATE notification_inbox_users SET initialized_at=now()-interval '1 minute' WHERE recipient_id=442"))
            for index in range(12):
                session.add(NotificationDelivery(recipient_id=442, event=f'new{index}', message=f'Новое {index}', created_at=datetime.now(timezone.utc)-timedelta(seconds=index)))
        result = client.get('/api/miniapp/notifications/inbox', headers=headers).json()
        assert result['unread'] and result['has_more'] and len(result['items']) == 10
        keys = [item['id'] for item in result['items']]
        assert client.post('/api/miniapp/notifications/inbox/read', headers=other, json={'ids':keys}).status_code == 200
        assert client.get('/api/miniapp/notifications/inbox', headers=other).json()['items'] == []
        assert client.post('/api/miniapp/notifications/inbox/read', headers=headers, json={'ids':keys}).status_code == 200
        assert client.get('/api/miniapp/notifications/inbox', headers=headers).json()['unread']
        second = client.get('/api/miniapp/notifications/inbox?offset=10', headers=headers).json()
        assert client.post('/api/miniapp/notifications/inbox/read', headers=headers, json={'ids':[x['id'] for x in second['items']]}).status_code == 200
        assert not client.get('/api/miniapp/notifications/inbox', headers=headers).json()['unread']
        with Session.begin() as session:
            session.add(NotificationDelivery(recipient_id=442, event='later', message='Поступило после открытия'))
        assert client.get('/api/miniapp/notifications/inbox', headers=headers).json()['unread']


def test_support_messages_are_visible_only_to_their_recipient(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        thread = SupportThread(customer_id=445, owner_id=200, request_number='inbox-test', screen='profile')
        session.add(thread)
        session.flush()
        session.add(SupportMessage(thread_id=thread.id, sender_id=200, direction='operator', ciphertext=b'x', nonce=b'x'))
    with TestClient(app) as client:
        customer = {"X-Telegram-Init-Data": signed_init_data(445)}
        stranger = {"X-Telegram-Init-Data": signed_init_data(446)}
        assert any(item['message'] == 'Новое сообщение в поддержке' for item in client.get('/api/miniapp/notifications/inbox', headers=customer).json()['items'])
        assert client.get('/api/miniapp/notifications/inbox', headers=stranger).json()['items'] == []
