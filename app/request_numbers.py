"""Formatting and parsing of human-readable rental request numbers.

Allocation and persistence are intentionally separate from this module.
"""
import re

_PATTERN = re.compile(r"^ТС([0-9]{2})([0-9]{4,})$")


def format_request_number(year, sequence):
    if not isinstance(year, int) or isinstance(year, bool) or not 2000 <= year <= 2099:
        raise ValueError("year must be between 2000 and 2099")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        raise ValueError("sequence must be positive")
    return f"ТС{year % 100:02d}{sequence:04d}"


def parse_request_number(value):
    match = _PATTERN.fullmatch(value)
    if not match:
        raise ValueError("invalid request number")
    year, sequence = int(match[1]) + 2000, int(match[2])
    if format_request_number(year, sequence) != value:
        raise ValueError("non-canonical request number")
    return year, sequence
