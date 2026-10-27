"""Server-side access lists and staged staff subroles."""

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


STAFF_ROLES = frozenset({"operator", "manager", "admin"})
ROLE_LEVELS = {"operator": 1, "manager": 2, "admin": 3}


def staff_subrole(user_id):
    """Return a configured staff member's persisted role, or None.

    PII membership is deliberately independent. A database row alone never
    grants staff access when the ID is absent from ADMIN_IDS.
    """
    if type(user_id) is not int or user_id not in configured_ids("ADMIN_IDS"):
        return None
    from .db import Session, StaffRole

    with Session() as session:
        staff = session.get(StaffRole, user_id)
        return staff.role if staff and staff.role in STAFF_ROLES else None


def staff_allows(user_id, minimum_role):
    """Enforce the configured staff list and the agreed role hierarchy."""
    if minimum_role not in ROLE_LEVELS:
        raise ValueError("Unknown minimum role")
    role = staff_subrole(user_id)
    return role is not None and ROLE_LEVELS[role] >= ROLE_LEVELS[minimum_role]


def audit_admin_access(user_id, entry_point):
    # Do not include Telegram profiles, initData, contacts or documents.
    logging.getLogger("polyrental.access").warning(
        "admin_access id=%s time=%s entry=%s", user_id,
        datetime.now(timezone.utc).isoformat(), entry_point,
    )
