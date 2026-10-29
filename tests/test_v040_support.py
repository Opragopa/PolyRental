from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import PIIAudit, Session, SupportMessage, SupportThread
from app.miniapp_server import app
from app.rental import reassign_booking, transition
from app.support import SupportConflict, claim_thread, submit_question
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def headers(user_id):
    return {'X-Telegram-Init-Data': signed_init_data(user_id)}


def test_support_encryption_owner_permissions_and_client_status(monkeypatch):
    configure(monkeypatch)
    import app.miniapp as miniapp
    monkeypatch.setattr(miniapp, 'notify_support_owner', AsyncMock())
    monkeypatch.setattr(miniapp, 'deliver_reply', AsyncMock(return_value=False))
    booking_id = pending_booking()
    transition(booking_id, 'confirmed', 100)
    reassign_booking(booking_id, 100, 200)
    with TestClient(app) as client:
        body = {'booking_id':booking_id, 'screen':'request', 'question':'Приватный вопрос 123'}
        assert client.post('/api/miniapp/support/questions', headers=headers(43), json=body).status_code == 422
        response = client.post('/api/miniapp/support/questions', headers=headers(42), json=body)
        assert response.status_code == 200
        thread_id = response.json()['id']
        url = f'/api/miniapp/admin/support/{thread_id}'
        with Session() as session:
            thread = session.get(SupportThread, thread_id)
            assert thread.owner_id == 200
            stored = session.scalar(select(SupportMessage).where(SupportMessage.thread_id == thread_id))
            assert 'Приватный вопрос'.encode() not in stored.ciphertext
        assert client.get(url + '/messages', headers=headers(100)).status_code == 403
        read = client.get(url + '/messages', headers=headers(200))
        assert read.status_code == 200 and read.json()['items'][0]['text'] == body['question']
        assert client.post(url + '/reply', headers=headers(100), json={'text':'Ответ'}).status_code == 403
        assert client.post(url + '/reply', headers=headers(200), json={'text':'Частный ответ'}).json()['status'] == 'queued'
        assert client.get('/api/miniapp/support/threads', headers=headers(43)).json()['items'] == []
        assert client.get('/api/miniapp/support/threads', headers=headers(42)).json()['items'][0]['status'] == 'Обращение получено'
        with Session() as session:
            replies = session.scalars(select(SupportMessage).where(SupportMessage.thread_id == thread_id, SupportMessage.direction == 'operator')).all()
            assert len(replies) == 1 and 'Частный ответ'.encode() not in replies[0].ciphertext
            actions = session.scalars(select(PIIAudit.action).where(PIIAudit.booking_id == booking_id)).all()
            assert 'support_read' in actions and 'support_reply' in actions


def test_support_claim_is_atomic(monkeypatch):
    configure(monkeypatch)
    thread_id = submit_question(42, None, 'profile', 'Вопрос')['id']
    def claim(actor):
        try:
            claim_thread(thread_id, actor)
            return 'claimed'
        except SupportConflict:
            return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(claim, (100, 200)))
    assert sorted(outcomes) == ['claimed', 'conflict']


def test_resolved_general_support_is_retained_then_purged(monkeypatch):
    from datetime import timedelta
    from app.support import purge_expired_support, resolve_thread
    configure(monkeypatch)
    thread_id = submit_question(42, None, 'profile', 'Личные данные')['id']
    claim_thread(thread_id, 200)
    from app.support import reply
    from datetime import datetime, timezone
    message_id = reply(thread_id, 200, 'Ответ')
    with Session.begin() as session:
        session.get(SupportMessage, message_id).delivered_at = datetime.now(timezone.utc)
    resolve_thread(thread_id, 200)
    with Session() as session:
        resolved = session.get(SupportThread, thread_id).resolved_at
    assert purge_expired_support(resolved + timedelta(days=89)) == 0
    assert purge_expired_support(resolved + timedelta(days=90)) == 2
    with Session() as session:
        assert not session.scalars(select(SupportMessage).where(SupportMessage.thread_id == thread_id)).all()
        assert session.scalar(select(PIIAudit.id).where(PIIAudit.action == 'support_retention_purge'))


def test_support_role_and_delivery_guards(monkeypatch):
    from datetime import datetime, timezone
    configure(monkeypatch)
    thread_id = submit_question(42, None, 'profile', 'Вопрос')['id']
    url = f'/api/miniapp/admin/support/{thread_id}'
    with TestClient(app) as client:
        assert client.post(url + '/claim', headers=headers(100)).status_code == 403
        assert client.post(url + '/claim', headers=headers(200)).status_code == 200
        assert client.post(url + '/resolve', headers=headers(200)).status_code == 403
        assert client.put(url + '/owner', headers=headers(200), json={'assignee_id':100}).status_code == 422
        assert client.post(url + '/reply', headers=headers(200), json={'text':'Ответ'}).status_code == 200
        assert client.post(url + '/resolve', headers=headers(200)).status_code == 403
        with Session.begin() as session:
            message = session.scalar(select(SupportMessage).where(SupportMessage.thread_id == thread_id, SupportMessage.direction == 'operator'))
            message.delivered_at = datetime.now(timezone.utc)
        assert client.post(url + '/resolve', headers=headers(200)).status_code == 200


def test_support_does_not_assign_staff_without_pii(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    transition(booking_id, 'confirmed', 100)
    reassign_booking(booking_id, 100, 100)
    thread = submit_question(42, booking_id, 'request', 'Вопрос')
    assert thread['owner_id'] is None
