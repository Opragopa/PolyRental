from datetime import date, datetime, timedelta, timezone

import pytest

from app.request_numbers import format_request_number, parse_request_number
from app.sla_clock import MOSCOW, add_business_time, business_time_between


def local(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=MOSCOW)


def test_sla_skips_weekend_and_configured_holidays():
    start = local(2026, 10, 30, 16, 30)  # Friday
    deadline = add_business_time(start, timedelta(hours=2), {date(2026, 11, 2)})
    assert deadline == local(2026, 11, 3, 10)
    assert business_time_between(start, deadline, {date(2026, 11, 2)}) == timedelta(hours=2)


def test_sla_summer_boundary_and_timezone_conversion():
    start = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)  # Friday 17:00 MSK
    assert add_business_time(start, timedelta(hours=2)) == local(2026, 6, 1, 10)
    assert business_time_between(start, local(2026, 6, 1, 10)) == timedelta(hours=2)


def test_sla_rejects_naive_and_negative_inputs():
    with pytest.raises(ValueError):
        add_business_time(datetime(2026, 1, 1), timedelta(hours=1))
    with pytest.raises(ValueError):
        add_business_time(local(2026, 1, 1, 9), -timedelta(seconds=1))


@pytest.mark.parametrize("seq", [1, 9999, 10000, 100000])
def test_number_round_trip_and_overflow(seq):
    number = format_request_number(2026, seq)
    assert parse_request_number(number) == (2026, seq)


@pytest.mark.parametrize("value", ["TC260001", "ТС260000", "ТС2600001", "ТС261", "ТС260001x"])
def test_number_rejects_invalid_or_noncanonical_values(value):
    with pytest.raises(ValueError):
        parse_request_number(value)
