from datetime import datetime, timedelta, timezone
import asyncio

import pytest
from fastapi import HTTPException

from app import miniapp, rental, service


@pytest.mark.parametrize("module", [rental, service])
def test_booking_allowed_today_but_not_in_the_past(monkeypatch, module):
    # Already 00:30 on 28 October in Moscow.
    fixed = datetime(2026, 10, 27, 21, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(module, "now", lambda: fixed)
    today = datetime(2026, 10, 28, 9, tzinfo=timezone.utc)
    module.validate_interval(today, today + timedelta(hours=1), True)
    past = fixed - timedelta(hours=1)
    with pytest.raises(ValueError, match="Начало аренды уже прошло"):
        module.validate_interval(past, past + timedelta(hours=2), True)


def test_availability_endpoint_accepts_today_and_rejects_past(monkeypatch):
    fixed = datetime(2026, 10, 27, 21, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(rental, "now", lambda: fixed)
    monkeypatch.setattr(miniapp, "availability", lambda start, end: [])
    today = datetime(2026, 10, 28, 9, tzinfo=timezone.utc)
    asyncio.run(miniapp.equipment_availability(today, today + timedelta(hours=1), page=None))
    past = fixed - timedelta(hours=1)
    with pytest.raises(HTTPException) as error:
        asyncio.run(miniapp.equipment_availability(past, past + timedelta(hours=2), page=None))
    assert error.value.status_code == 422
    assert error.value.detail == "Начало аренды уже прошло"
