from datetime import date, time

from app.schedule import is_working_day, working_hours


def test_2026_official_holiday_and_transfer():
    assert not is_working_day(date(2026, 11, 4))
    assert not is_working_day(date(2026, 12, 31))
    assert not is_working_day(date(2027, 1, 1))


def test_summer_hours():
    assert working_hours(date(2026, 7, 3)) == (time(8, 30), time(20, 0))
    assert working_hours(date(2026, 10, 26)) == (time(9, 0), time(20, 0))


def test_institution_calendar_overrides(monkeypatch):
    monkeypatch.setenv("NON_WORKING_DATES", "2026-10-27")
    monkeypatch.setenv("WORKING_DATES", "2026-10-31")
    assert not is_working_day(date(2026, 10, 27))
    assert is_working_day(date(2026, 10, 31))
