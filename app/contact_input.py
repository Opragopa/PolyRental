"""Normalize common pasted contact formats without guessing an identity."""
import re


def normalize_contact(value: str) -> str:
    value = value.strip()
    link = re.fullmatch(r"(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me)/([A-Za-z][A-Za-z0-9_]{4,31})/?", value, re.I)
    if link:
        return "@" + link.group(1)
    return value.translate(str.maketrans({"\u00a0": " ", "\u202f": " ", "\u2011": "-", "\u2013": "-", "\u2014": "-"}))
