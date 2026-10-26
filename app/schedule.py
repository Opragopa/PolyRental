"""Moscow working calendar for planned issue and return schedules."""

import os
from datetime import date, time


FEDERAL_HOLIDAYS = {(1, day) for day in range(1, 9)} | {
    (2, 23), (3, 8), (5, 1), (5, 9), (6, 12), (11, 4),
}

# Federal five-day calendar for 2026, including Government decree No. 1466.
# Future annual transfers and institution-specific closures use environment overrides.
NON_WORKING_2026 = frozenset(
    {date(2026, 1, day) for day in range(1, 10)} |
    {date(2026, 2, 23), date(2026, 3, 9), date(2026, 5, 1),
     date(2026, 5, 11), date(2026, 6, 12), date(2026, 11, 4), date(2026, 12, 31)}
)


def _dates_from_env(name):
    return {date.fromisoformat(value.strip()) for value in os.getenv(name, "").split(",") if value.strip()}


def is_working_day(day):
    if day in _dates_from_env("WORKING_DATES"):
        return True
    if day in _dates_from_env("NON_WORKING_DATES") or day in NON_WORKING_2026 or (day.month, day.day) in FEDERAL_HOLIDAYS:
        return False
    return day.weekday() < 5


def working_hours(day):
    """Weekdays: 09:00–17:30; June through August: 08:30–17:00."""
    return (time(8, 30), time(17, 0)) if 6 <= day.month <= 8 else (time(9, 0), time(17, 30))
