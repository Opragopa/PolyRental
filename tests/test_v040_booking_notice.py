from datetime import datetime, timedelta, timezone
import asyncio

import pytest
from fastapi import HTTPException

from app import miniapp, rental, service


@pytest.mark.parametrize("module", [rental, service])
def test_booking_notice_uses_three_moscow_calendar_days(monkeypatch, module):
    # 21:30 UTC is already the next calendar day in Moscow.
    fixed = datetime(2026, 10, 27, 21, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(module, "now", lambda: fixed)
    too_early = datetime(2026, 10, 30, 9, tzinfo=timezone.utc)
    allowed = datetime(2026, 10, 31, 9, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="Бронирование доступно минимум за 3 дня"):
        module.validate_interval(too_early, too_early + timedelta(hours=1), True)
    module.validate_interval(allowed, allowed + timedelta(hours=1), True)


def test_availability_endpoint_rejects_early_start(monkeypatch):
    fixed = datetime(2026, 10, 27, 21, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(rental, "now", lambda: fixed)
    monkeypatch.setattr(miniapp, "availability", lambda start, end: [])
    start = datetime(2026, 10, 30, 9, tzinfo=timezone.utc)
    with pytest.raises(HTTPException) as error:
        asyncio.run(miniapp.equipment_availability(start, start + timedelta(hours=1)))
    assert error.value.status_code == 422
    assert error.value.detail == "Бронирование доступно минимум за 3 дня"
