"""Server-side roles shared by every entry point; env is the only ID source."""

import logging
import os
import re
from datetime import datetime, timezone


def configured_ids(name):
    if name not in {"ADMIN_IDS", "PII_ADMIN_IDS"}:
        raise ValueError("Unknown role setting")
    raw = os.getenv(name, "").strip()
    if not raw:
        if name == "ADMIN_IDS":
            raise RuntimeError("ADMIN_IDS обязателен: укажите Telegram ID через запятую")
        return frozenset()
    parts = [part.strip() for part in raw.split(",")]
    if any(not re.fullmatch(r"[1-9][0-9]{0,18}", part) or int(part) > 2**63 - 1 for part in parts):
        raise RuntimeError(f"{name}: ожидаются положительные Telegram ID через запятую")
    return frozenset(map(int, parts))


def validate_role_config():
    configured_ids("ADMIN_IDS")
    configured_ids("PII_ADMIN_IDS")


def role_for(user_id):
    pii = type(user_id) is int and user_id in configured_ids("PII_ADMIN_IDS")
    admin = type(user_id) is int and user_id in configured_ids("ADMIN_IDS")
    return {"id": user_id, "admin": admin or pii, "pii_admin": pii}


def is_staff(user_id):
    return role_for(user_id)["admin"]


def audit_admin_access(user_id, entry_point):
    # Do not include Telegram profiles, initData, contacts or documents.
    logging.getLogger("polyrental.access").warning(
        "admin_access id=%s time=%s entry=%s", user_id,
        datetime.now(timezone.utc).isoformat(), entry_point,
    )
