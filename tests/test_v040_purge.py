from datetime import timedelta
from fastapi.testclient import TestClient
from app.miniapp_server import app
from app.rental import availability, create_booking, get_booking, now, save_article, save_equipment
from tests.test_miniapp import configure, signed_init_data


def headers(user_id):
    return {'X-Telegram-Init-Data': signed_init_data(user_id)}


def make_test_booking():
    article = save_article('TEST-UNIT', 'Тестовая модель', '', 0)
    save_equipment('', '', '', 0, 'available', article_id=article)
    start = now() + timedelta(days=5)
    booking_id = create_booking(42, 'Клиент', '@test', start, start + timedelta(hours=1), [{'article_id':article,'quantity':1}])
    return booking_id, article, start


def test_hide_preserves_reservation_and_admin_unhides(monkeypatch):
    configure(monkeypatch)
    booking_id, article, start = make_test_booking()
    assert get_booking(booking_id).is_test
    base = f'/api/miniapp/admin/bookings/{booking_id}'
    with TestClient(app) as client:
        assert client.post(base+'/hide-test', headers=headers(42)).status_code == 403
        assert client.post(base+'/hide-test', headers=headers(200)).status_code == 200
        assert not client.get('/api/miniapp/bookings', headers=headers(42)).json()['items']
        assert next(x for x in availability(start, start+timedelta(hours=1)) if x['id']==article)['available_quantity'] == 1
        assert client.post(base+'/restore', headers=headers(200)).status_code == 403
        assert client.post(base+'/restore', headers=headers(100)).status_code == 200
        assert get_booking(booking_id) is not None


def test_irreversible_purge_endpoint_is_unavailable(monkeypatch):
    configure(monkeypatch)
    booking_id, _, _ = make_test_booking()
    url = f'/api/miniapp/service/bookings/{booking_id}/purge'
    with TestClient(app) as client:
        assert client.post(url, headers=headers(100), json={'confirmation': 'anything', 'reason': 'test_cleanup'}).status_code == 404
    assert get_booking(booking_id) is not None
