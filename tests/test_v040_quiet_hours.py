import asyncio
from datetime import datetime
from unittest.mock import AsyncMock
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.db import NotificationDelivery, Session
from app.miniapp_server import app
from app.notification_outbox import notify_actionable
from app.operator_preferences import next_actionable_time
from app.sla_clock import MOSCOW
from tests.test_miniapp import configure, signed_init_data


def headers(uid): return {'X-Telegram-Init-Data': signed_init_data(uid)}


def test_quiet_hours_are_private_and_delay_mandatory_action(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv('SLA_HOLIDAYS', '')
    with TestClient(app) as client:
        url='/api/miniapp/admin/notification-preferences'
        assert client.get(url, headers=headers(42)).status_code == 403
        assert client.put(url, headers=headers(100), json={'quiet_start':'22:00','quiet_end':None}).status_code == 422
        assert client.put(url, headers=headers(100), json={'quiet_start':'22:00','quiet_end':'08:00'}).status_code == 200
        assert client.get(url, headers=headers(200)).json()['quiet_start'] is None
        at = datetime(2026,11,2,23,0,tzinfo=MOSCOW)
        assert next_actionable_time(100, at) == datetime(2026,11,3,8,0,tzinfo=MOSCOW)
        import app.notification_outbox as outbox
        monkeypatch.setattr(outbox, '_now', lambda: at)
        deliver = AsyncMock()
        monkeypatch.setattr(outbox, 'deliver_notification', deliver)
        assert asyncio.run(notify_actionable(None,100,'support_action','Новое обращение'))
        deliver.assert_not_called()
        with Session() as session:
            row = session.scalar(select(NotificationDelivery).where(NotificationDelivery.event=='support_action'))
            assert row.next_retry_at == datetime(2026,11,3,8,0,tzinfo=MOSCOW)


def test_default_quiet_hours_follow_summer_weekends(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv('SLA_HOLIDAYS', '')
    at = datetime(2026,5,29,18,0,tzinfo=MOSCOW)
    assert next_actionable_time(100, at) == datetime(2026,6,1,8,30,0,1,tzinfo=MOSCOW)
