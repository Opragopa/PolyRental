"""Moscow working calendar for planned issue and return schedules."""

import os
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


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
    """Weekdays close at 20:00; summer opening remains 08:30."""
    return (time(8, 30), time(20, 0)) if 6 <= day.month <= 8 else (time(9, 0), time(20, 0))


def current_time():
    return datetime.now(timezone.utc)


def schedule_enforced():
    return os.getenv("ENFORCE_HANDOVER_SCHEDULE", "true").lower() not in {"false", "0", "no"}


def validate_planned_slot(value, label="Выдача или приём"):
    if not schedule_enforced():
        return
    local = value.astimezone(ZoneInfo("Europe/Moscow"))
    opening, closing = working_hours(local.date())
    if not is_working_day(local.date()) or not opening <= local.time() <= closing:
        raise ValueError(f"{label}: выберите рабочий день и время {opening:%H:%M}–{closing:%H:%M} по Москве")


def validate_operation_window():
    try:
        validate_planned_slot(current_time())
    except ValueError as exc:
        from .rental import Conflict
        raise Conflict(str(exc)) from exc


def next_working_slot(value):
    local = value.astimezone(ZoneInfo("Europe/Moscow"))
    for _ in range(370):
        opening, closing = working_hours(local.date())
        if is_working_day(local.date()) and local.time() <= closing:
            return max(local, datetime.combine(local.date(), opening, tzinfo=local.tzinfo))
        local = datetime.combine(local.date() + timedelta(days=1), time(), tzinfo=local.tzinfo)
    raise ValueError("Рабочее окно не найдено; проверьте календарь")


def schedule_policy():
    return {"enforced": schedule_enforced(),
            "closed_dates": sorted(day.isoformat() for day in NON_WORKING_2026 | _dates_from_env("NON_WORKING_DATES")),
            "working_dates": sorted(day.isoformat() for day in _dates_from_env("WORKING_DATES")),
            "annual_holidays": sorted(f"{month:02d}-{day:02d}" for month, day in FEDERAL_HOLIDAYS),
            "normal": {"start":"09:00","end":"20:00"}, "summer":{"start":"08:30","end":"20:00"}}
