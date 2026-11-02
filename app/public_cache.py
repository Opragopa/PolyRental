"""Optional Redis cache for public catalogue data; never stores customer data."""
import hashlib
import json
import logging
import os
import threading
import time

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .db import engine

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_client = None
_client_url = None
_retry_after = 0.0
_MAX_ENTRY_BYTES = 2 * 1024 * 1024


def _get_client():
    global _client, _client_url, _retry_after
    url = os.getenv('REDIS_URL', '').strip()
    if not url or time.monotonic() < _retry_after:
        return None
    with _lock:
        if _client is None or _client_url != url:
            try:
                import redis
                _client = redis.Redis.from_url(url, socket_connect_timeout=.15, socket_timeout=.15,
                                               health_check_interval=30, decode_responses=False)
                _client_url = url
            except (ImportError, ValueError) as exc:
                logger.warning('Cache configuration unavailable (%s)', type(exc).__name__)
                _retry_after = time.monotonic() + 10
                return None
        return _client


def _disable_temporarily(exc):
    global _client, _retry_after
    with _lock:
        _client = None
        _retry_after = time.monotonic() + 5
    logger.warning('Cache unavailable (%s); reading from database', type(exc).__name__)


def _revision():
    with engine.connect() as connection:
        return connection.execute(text('SELECT revision FROM availability_cache_revision WHERE id = 1')).scalar_one()


def cached_public_value(kind, parameters, producer, ttl, *, revision=True):
    """Cache only public, JSON-serializable data; any cache failure falls back."""
    client = _get_client()
    if client is None:
        return producer()
    try:
        version = _revision() if revision else 0
        # Separate DBs and releases without putting credentials or raw query values in keys.
        identity = f'{engine.url.host}:{engine.url.port}/{engine.url.database}'
        from . import __version__
        raw_key = json.dumps([identity, __version__, kind, version, parameters], ensure_ascii=True, sort_keys=True, separators=(',', ':'))
        key = 'polyrental:public:' + hashlib.sha256(raw_key.encode('utf-8')).hexdigest()
        value = client.get(key)
        if value is not None:
            return json.loads(value)
    except SQLAlchemyError:
        # Do not use unversioned cached data if the revision cannot be read.
        return producer()
    except (Exception) as exc:
        _disable_temporarily(exc)
        return producer()
    result = producer()
    try:
        encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) <= _MAX_ENTRY_BYTES:
            client.setex(key, ttl, encoded)
    except (TypeError, ValueError):
        logger.warning('Public cache value could not be serialized')
    except Exception as exc:
        _disable_temporarily(exc)
    return result
