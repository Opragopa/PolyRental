from datetime import timedelta

import pytest
from sqlalchemy import select

from app import public_cache
from app.catalog_categories import create_category, list_categories
from app.db import Article, Session
from app.rental import availability, now
from tests.test_integration import article_with_assets


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.ttls = []

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, ttl, value):
        self.ttls.append(ttl)
        self.values[key] = value


def test_cache_invalidates_atomically_after_catalog_commit(monkeypatch):
    article_id = article_with_assets('CACHE-CAMERA', 1)
    fake = FakeRedis()
    monkeypatch.setattr(public_cache, '_get_client', lambda: fake)
    start, end = now() + timedelta(days=4), now() + timedelta(days=4, hours=1)
    calls = []
    def load():
        calls.append(1)
        return availability(start, end)
    params = {'start':start.isoformat(), 'end':end.isoformat()}
    first = public_cache.cached_public_value('availability', params, load, 5)
    again = public_cache.cached_public_value('availability', params, load, 5)
    assert first == again and len(calls) == 1 and fake.ttls == [5]
    with Session.begin() as session:
        session.get(Article, article_id).name = 'Обновлённая модель'
    after = public_cache.cached_public_value('availability', params, load, 5)
    assert len(calls) == 2 and after[0]['name'] == 'Обновлённая модель'
    revision = public_cache._revision()
    with pytest.raises(RuntimeError):
        with Session.begin() as session:
            session.get(Article, article_id).name = 'Откат'
            session.flush()
            raise RuntimeError('rollback')
    assert public_cache._revision() == revision
    assert public_cache.cached_public_value('availability', params, load, 5) == after
    assert len(calls) == 2


def test_category_cache_invalidated_by_category_creation(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(public_cache, '_get_client', lambda: fake)
    calls = []
    def load():
        calls.append(1)
        return list_categories()
    initial = public_cache.cached_public_value('categories', {}, load, 300)
    assert public_cache.cached_public_value('categories', {}, load, 300) == initial and len(calls) == 1
    created = create_category('Тестовая категория для кэша', 100)
    updated = public_cache.cached_public_value('categories', {}, load, 300)
    assert len(calls) == 2 and created in updated


def test_cache_failure_falls_back_to_source(monkeypatch):
    class BrokenRedis:
        def get(self, key):
            raise OSError('unavailable')
    monkeypatch.setattr(public_cache, '_get_client', lambda: BrokenRedis())
    calls = []
    result = public_cache.cached_public_value('availability', {'start':'test'}, lambda: calls.append(1) or [{'id':7}], 5)
    assert result == [{'id':7}] and calls == [1]


def test_real_redis_and_database_commit(monkeypatch):
    import os
    import time
    redis_url = os.getenv('POLYRENTAL_TEST_REDIS_URL')
    if not redis_url:
        pytest.skip('requires isolated test Redis')
    assert redis_url.endswith('/15'), 'integration test requires dedicated Redis DB 15'
    monkeypatch.setenv('REDIS_URL', redis_url)
    monkeypatch.setattr(public_cache, '_client', None)
    monkeypatch.setattr(public_cache, '_client_url', None)
    monkeypatch.setattr(public_cache, '_retry_after', 0.0)
    article_id = article_with_assets('CACHE-REDIS', 1)
    calls = []
    def load():
        calls.append(1)
        with Session() as session:
            return {'name':session.get(Article, article_id).name}
    params = {'isolation':str(time.time_ns())}
    assert public_cache.cached_public_value('redis-test', params, load, 5)['name'] == 'CACHE-REDIS'
    assert public_cache.cached_public_value('redis-test', params, load, 5)['name'] == 'CACHE-REDIS'
    assert len(calls) == 1
    with Session.begin() as session:
        session.get(Article, article_id).name = 'Обновлено после кэширования'
    assert public_cache.cached_public_value('redis-test', params, load, 5)['name'] == 'Обновлено после кэширования'
    assert len(calls) == 2
    # Redis failure never blocks the underlying read.
    monkeypatch.setenv('REDIS_URL', 'redis://127.0.0.1:1/15')
    assert public_cache.cached_public_value('redis-test', params, load, 5)['name'] == 'Обновлено после кэширования'
    assert len(calls) == 3


def test_availability_api_refreshes_after_booking_commit(monkeypatch):
    from fastapi.testclient import TestClient
    import app.miniapp as miniapp_api
    from app.db import Booking, BookingLine
    from app.miniapp_server import app
    from tests.test_miniapp import configure
    configure(monkeypatch)
    article_id = article_with_assets('CACHE-BOOKING', 1)
    fake = FakeRedis()
    monkeypatch.setattr(public_cache, '_get_client', lambda: fake)
    original = miniapp_api.availability
    calls = []
    def counted(start, end):
        calls.append(1)
        return original(start, end)
    monkeypatch.setattr(miniapp_api, 'availability', counted)
    start = now() + timedelta(days=4)
    end = start + timedelta(hours=2)
    with TestClient(app) as client:
        params = {'start':start.isoformat(), 'end':end.isoformat()}
        first = client.get('/api/miniapp/availability', params=params).json()
        again = client.get('/api/miniapp/availability', params=params).json()
        assert first == again and len(calls) == 1 and first['items'][0]['available_quantity'] == 1
        with Session.begin() as session:
            booking = Booking(customer_id=42, customer_name='QA', customer_contact='@qa', status='confirmed', starts_at=start, ends_at=end)
            session.add(booking); session.flush()
            session.add(BookingLine(booking_id=booking.id, article_id=article_id, quantity=1, hourly_rate=0))
        latest = client.get('/api/miniapp/availability', params=params).json()
        assert len(calls) == 2 and latest['all_items'][0]['available_quantity'] == 0
