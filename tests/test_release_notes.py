from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import release_notes
from app.db import ClientActivity, Session, SupportMessage
from app.miniapp_server import app
from app.support import _open, submit_question
from tests.test_miniapp import configure, signed_init_data


def test_running_version_has_a_release_announcement():
    from app import __version__
    release = release_notes.current_release()
    assert release is not None, f"Add release notes before deploying {__version__}"
    assert release["version"] == __version__.split("-hotfix")[0]


def test_release_acknowledgement_is_per_user_and_hotfix_keeps_identity(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(release_notes, '__version__', '0.5.1')
    assert release_notes.release_for_user(42)['seen'] is False
    with ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda _:release_notes.mark_release_seen(42,'0.5.1'),range(8)))
    assert sum(results)==1
    assert release_notes.release_for_user(42)['seen'] is True
    assert release_notes.release_for_user(43)['seen'] is False
    monkeypatch.setattr(release_notes,'__version__','0.5.1-hotfix-1')
    assert release_notes.release_for_user(42)['version']=='0.5.1'
    assert release_notes.release_for_user(42)['seen'] is True
    monkeypatch.setattr(release_notes,'__version__','0.5.99')
    assert release_notes.current_release() is None  # never reuse unrelated notes


def test_release_api_requires_login_filters_staff_notes_and_validates_version(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(release_notes,'__version__','0.5.1')
    monkeypatch.setattr('app.miniapp_server.retry_pending_notifications',AsyncMock())
    headers=lambda user:{'X-Telegram-Init-Data':signed_init_data(user)}
    with TestClient(app) as client:
        assert client.get('/api/miniapp/release').status_code==401
        assert client.post('/api/miniapp/release/seen',json={'version':'0.5.1'}).status_code==401
        customer=client.get('/api/miniapp/release',headers=headers(42)).json()['release']
        staff=client.get('/api/miniapp/release',headers=headers(100)).json()['release']
        assert len(customer['items'])==5 and len(staff['items'])==6
        assert not customer['seen']
        assert client.post('/api/miniapp/release/seen',headers=headers(42),json={'version':'0.5.2'}).status_code==409
        assert client.post('/api/miniapp/release/seen',headers=headers(42),json={'version':'0.5.1','user_id':43}).status_code==422
        for _ in range(2):
            assert client.post('/api/miniapp/release/seen',headers=headers(42),json={'version':'0.5.1'}).status_code==200
        assert client.get('/api/miniapp/release',headers=headers(42)).json()['release']['seen'] is True
        assert client.get('/api/miniapp/release',headers=headers(43)).json()['release']['seen'] is False
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(ClientActivity).where(ClientActivity.action=='release_seen:0.5.1'))==1


def test_suggestion_reuses_support_encrypts_and_labels_message_and_thanks_after_success(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr('app.miniapp_server.retry_pending_notifications',AsyncMock())
    monkeypatch.setattr('app.miniapp.notify_support_owner',AsyncMock())
    original=submit_question(42,None,'profile','Прежний вопрос')
    headers={'X-Telegram-Init-Data':signed_init_data(42)}
    with TestClient(app) as client:
        body={'screen':'feedback','question':'Добавьте поиск по ячейке','booking_id':None}
        response=client.post('/api/miniapp/support/questions',headers=headers,json=body)
        assert response.status_code==200 and response.json()['id']==original['id']
        assert response.json()['status']=='Спасибо! Мы рассмотрим ваше предложение.'
        assert client.post('/api/miniapp/support/questions',headers=headers,json={**body,'question':'   '}).status_code==422
    with Session() as session:
        messages=session.scalars(select(SupportMessage).where(SupportMessage.thread_id==original['id']).order_by(SupportMessage.id)).all()
        assert len(messages)==2
        assert _open(messages[-1])=='Предложение по приложению:\nДобавьте поиск по ячейке'
        assert 'Добавьте поиск'.encode() not in messages[-1].ciphertext
