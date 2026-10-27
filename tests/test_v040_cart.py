from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from app.cart import CartConflict, get_cart, put_cart
from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def headers(user_id):
    return {'X-Telegram-Init-Data': signed_init_data(user_id)}


def test_cart_is_private_validated_and_versioned(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        assert client.get('/api/miniapp/cart').status_code == 401
        assert client.get('/api/miniapp/cart', headers=headers(42)).json()['version'] == 0
        payload = {'start':'2026-12-01T10:00', 'end':'2026-12-02T10:00',
                   'lines':[{'article_id':1,'quantity':2}], 'version':0}
        assert client.put('/api/miniapp/cart', headers=headers(42), json=payload).json()['version'] == 1
        assert client.put('/api/miniapp/cart', headers=headers(42), json=payload).status_code == 409
        assert client.get('/api/miniapp/cart', headers=headers(43)).json()['lines'] == []
        assert client.get('/api/miniapp/cart', headers=headers(42)).json()['lines'] == payload['lines']
        payload['version'] = 1
        payload['lines'].append({'article_id':1,'quantity':1})
        assert client.put('/api/miniapp/cart', headers=headers(42), json=payload).status_code == 422
        payload['lines'] = []
        payload['start'] = '2026-02-31T10:00'
        assert client.put('/api/miniapp/cart', headers=headers(42), json=payload).status_code == 422


def test_competing_cart_writes_have_one_winner():
    get_cart(42)
    def write(article_id):
        try:
            return put_cart(42, '', '', [{'article_id':article_id, 'quantity':1}], 0)['version']
        except CartConflict:
            return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(write, (1,2)))
    assert sorted(map(str, outcomes)) == ['1','conflict']
