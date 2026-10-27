"""Business-time arithmetic for the v0.4 SLA calendar.

This calendar is deliberately separate from the issue/return schedule: SLA
holidays start empty and can be configured independently.
"""
import os
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")


def configured_holidays():
    """Read comma-separated ISO dates; an empty setting means no holidays."""
    values = [value.strip() for value in os.getenv("SLA_HOLIDAYS", "").split(",") if value.strip()]
    try:
        if any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) for value in values):
            raise ValueError("invalid date format")
        return frozenset(date.fromisoformat(value) for value in values)
    except ValueError as exc:
        raise ValueError("SLA_HOLIDAYS: ожидаются даты YYYY-MM-DD через запятую") from exc


def _local(value):
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("SLA timestamps must be timezone-aware")
    return value.astimezone(MOSCOW)


def _window(day, holidays):
    if day.weekday() >= 5 or day in holidays:
        return None
    start, end = ((time(8, 30), time(17)) if 6 <= day.month <= 8
                  else (time(9), time(17, 30)))
    return (datetime.combine(day, start, MOSCOW), datetime.combine(day, end, MOSCOW))


def add_business_time(start, duration, holidays=None):
    """Return the Moscow deadline after a non-negative business duration."""
    current = _local(start)
    if duration < timedelta(0):
        raise ValueError("duration must be non-negative")
    if duration == timedelta(0):
        return current
    holidays = configured_holidays() if holidays is None else frozenset(holidays)
    while True:
        window = _window(current.date(), holidays)
        if window:
            opening, closing = window
            current = max(current, opening)
            if current < closing:
                available = closing - current
                if duration <= available:
                    return current + duration
                duration -= available
        next_day = current.date() + timedelta(days=1)
        current = datetime.combine(next_day, time.min, MOSCOW)


def business_time_between(start, end, holidays=None):
    """Measure elapsed business time between two aware timestamps."""
    start, end = _local(start), _local(end)
    if end < start:
        raise ValueError("end must not precede start")
    holidays = configured_holidays() if holidays is None else frozenset(holidays)
    total = timedelta(0)
    day = start.date()
    while day <= end.date():
        window = _window(day, holidays)
        if window:
            left, right = max(start, window[0]), min(end, window[1])
            if right > left:
                total += right - left
        day += timedelta(days=1)
    return total
