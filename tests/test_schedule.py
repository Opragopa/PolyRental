from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.schedule import is_working_day, response_deadline


MSK = ZoneInfo("Europe/Moscow")


def deadline_local(year, month, day, hour, minute):
    created = datetime(year, month, day, hour, minute, tzinfo=MSK)
    return response_deadline(created).astimezone(MSK)


def test_business_hour_booking_keeps_half_hour():
    assert deadline_local(2026, 10, 26, 10, 0) == datetime(2026, 10, 26, 10, 30, tzinfo=MSK)


def test_saturday_booking_waits_until_monday_close():
    assert deadline_local(2026, 10, 24, 12, 0) == datetime(2026, 10, 26, 17, 30, tzinfo=MSK)


def test_evening_booking_waits_until_next_business_close():
    assert deadline_local(2026, 10, 26, 17, 20) == datetime(2026, 10, 27, 17, 30, tzinfo=MSK)


def test_early_morning_booking_waits_until_same_day_close():
    assert deadline_local(2026, 10, 26, 8, 0) == datetime(2026, 10, 26, 17, 30, tzinfo=MSK)


def test_summer_hours():
    assert deadline_local(2026, 7, 3, 16, 50) == datetime(2026, 7, 6, 17, 0, tzinfo=MSK)
    assert response_deadline(datetime(2026, 7, 3, 7, 0, tzinfo=timezone.utc)).tzinfo == timezone.utc


def test_2026_official_holiday_and_transfer():
    assert not is_working_day(datetime(2026, 11, 4).date())
    assert deadline_local(2026, 11, 3, 18, 0) == datetime(2026, 11, 5, 17, 30, tzinfo=MSK)
    assert not is_working_day(datetime(2026, 12, 31).date())
    assert not is_working_day(datetime(2027, 1, 1).date())


def test_institution_calendar_overrides(monkeypatch):
    monkeypatch.setenv("NON_WORKING_DATES", "2026-10-27")
    monkeypatch.setenv("WORKING_DATES", "2026-10-31")
    assert deadline_local(2026, 10, 26, 18, 0) == datetime(2026, 10, 28, 17, 30, tzinfo=MSK)
    assert is_working_day(datetime(2026, 10, 31).date())
