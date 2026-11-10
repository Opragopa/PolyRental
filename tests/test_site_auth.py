import hashlib
import hmac
import re
import time
from urllib.parse import urlencode

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.miniapp import require_customer
from app.site_auth import router


def test_telegram_site_login(monkeypatch):
    monkeypatch.setenv('SESSION_SECRET', 'a sufficiently long test secret of 40 characters')
    monkeypatch.setenv('BOT_TOKEN', '123456:test-token')
    monkeypatch.setenv('BOT_USERNAME', 'polyrental_test_bot')
    monkeypatch.setenv('PUBLIC_URL', 'http://testserver')
    app = FastAPI(); app.include_router(router)
    @app.get('/protected')
    def protected(user=Depends(require_customer)): return user
    @app.post('/protected')
    def write(user=Depends(require_customer)): return user
    client = TestClient(app)
    assert client.get('/protected').status_code == 401
    login = client.get('/site/login')
    assert 'data-bot="polyrental_test_bot"' in login.text
    assert '/miniapp/static/site-login.js?v=' in login.text
    state = re.search(r'state=([A-Za-z0-9_-]+)', login.text).group(1)
    payload = {'id': '42', 'first_name': 'Ирина', 'auth_date': str(int(time.time()))}
    check = '\n'.join(f'{k}={v}' for k, v in sorted(payload.items()))
    payload['hash'] = hmac.new(hashlib.sha256(b'123456:test-token').digest(), check.encode(), hashlib.sha256).hexdigest()
    assert client.get('/site/auth', params={'state':'incorrect', **payload}, follow_redirects=False).status_code == 403
    assert client.get('/site/auth', params={'state':state, **{**payload, 'first_name':'Другой'}}, follow_redirects=False).status_code == 403
    assert client.get('/site/auth', params={'state':state, **payload}, follow_redirects=False).status_code == 303
    assert client.get('/protected').json()['id'] == 42
    assert client.post('/protected').status_code == 403
    assert client.post('/protected', headers={'Origin':'http://evil.test','X-Telegram-Init-Data':''}).status_code == 403
    assert client.post('/protected', headers={'Origin':'http://testserver','X-Telegram-Init-Data':''}).status_code == 200
    assert client.post('/site/logout', headers={'Origin':'http://testserver','X-Telegram-Init-Data':''}, follow_redirects=False).status_code == 303
    assert client.get('/protected').status_code == 401


def test_local_preview_bypasses_telegram_only_on_loopback(monkeypatch):
    monkeypatch.setenv('SESSION_SECRET', 'a sufficiently long test secret of 40 characters')
    monkeypatch.setenv('LOCAL_SITE_AUTH_BYPASS_USER_ID', '100')
    monkeypatch.delenv('BOT_TOKEN', raising=False)
    monkeypatch.delenv('BOT_USERNAME', raising=False)
    app = FastAPI(); app.include_router(router)
    @app.get('/protected')
    def protected(user=Depends(require_customer)): return user

    local = TestClient(app, base_url='http://127.0.0.1:18080')
    login = local.get('/site/login', follow_redirects=False)
    assert login.status_code == 303
    assert login.headers['location'] == '/site'
    assert local.get('/protected').json()['id'] == 100

    remote = TestClient(app, base_url='http://testing.example')
    assert remote.get('/site/login').status_code == 503
