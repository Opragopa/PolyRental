"""Human-readable Telegram identities; numeric IDs stay internal."""
import re

from sqlalchemy import select, text


def clean_name(value):
    value = " ".join(str(value or "").split())[:200]
    if value.casefold() in {"сотрудник", "оператор", "пользователь", "клиент"}:
        return ""
    if re.fullmatch(r"(?:(?:оператор|сотрудник|пользователь|клиент)\s*)?(?:ID\s*)?-?\d+", value, re.I):
        return ""
    return value


def telegram_name(user, fallback="Пользователь"):
    get = user.get if isinstance(user, dict) else lambda key, default="": getattr(user, key, default)
    name = clean_name(" ".join(filter(None, [clean_name(get("first_name")), clean_name(get("last_name"))])))
    name = name or clean_name(get("full_name"))
    username = clean_name(get("username"))
    return name or (f"@{username.lstrip('@')}"[:200] if username else fallback)


def user_names(session, user_ids):
    # Callers also resolve names while constructing transactional workflow rows.
    with session.no_autoflush:
        return _user_names(session, user_ids)


def _user_names(session, user_ids):
    from .db import Booking, ClientProfile, StaffRole, TrustedSigner
    ids = {uid for uid in user_ids if uid}
    names = {}
    if not ids:
        return names
    for row in session.scalars(select(ClientProfile).where(ClientProfile.telegram_id.in_(ids))):
        if name := clean_name(row.display_name):
            names[row.telegram_id] = name
    for row in session.scalars(select(StaffRole).where(StaffRole.telegram_id.in_(ids))):
        if name := clean_name(row.display_name):
            names.setdefault(row.telegram_id, name)
    for row in session.scalars(select(TrustedSigner).where(TrustedSigner.telegram_id.in_(ids))):
        if name := clean_name(row.full_name):
            names.setdefault(row.telegram_id, name)
    # Only public booking names, never passport/identity payloads.
    missing = ids - names.keys()
    if missing:
        for uid, name in session.execute(select(Booking.customer_id, Booking.customer_name).where(
                Booking.customer_id.in_(missing)).order_by(Booking.created_at.desc(), Booking.id.desc())):
            if name := clean_name(name):
                names.setdefault(uid, name)
    return names


def user_name(session, user_id, fallback="Сотрудник", saved=""):
    if not user_id:
        return "Система"
    return clean_name(saved) or user_names(session, [user_id]).get(user_id, fallback)


def history_names(session, items):
    ids = {item["actor_id"] for item in items if item.get("actor_id")}
    targets = {}
    for item in items:
        prefix, _, value = item["action"].partition(":")
        if prefix in {"assignee", "support_owner"} and value.isdigit():
            targets[item["id"]] = int(value)
            ids.add(int(value))
    names = user_names(session, ids)
    for item in items:
        item["actor_name"] = names.get(item["actor_id"], "Пользователь") if item["actor_id"] else "Система"
        if item["id"] in targets:
            item["target_name"] = names.get(targets[item["id"]], "Сотрудник")
    return items


def remember_user_name(user):
    """Refresh names only from authenticated Telegram events or signed login."""
    from .db import ClientProfile, Session, StaffRole
    uid = user.get("id") if isinstance(user, dict) else user.id
    name = telegram_name(user, "")
    if name:
        with Session.begin() as session:
            profile = session.get(ClientProfile, uid)
            if profile is None:
                session.execute(text("INSERT INTO client_profiles (telegram_id, display_name, created_at) VALUES (:id, :name, COALESCE((SELECT MIN(created_at) FROM bookings WHERE customer_id=:id), now())) ON CONFLICT (telegram_id) DO UPDATE SET display_name=EXCLUDED.display_name"), {"id": uid, "name": name})
            elif profile.display_name != name:
                profile.display_name = name
            staff = session.get(StaffRole, uid)
            if staff and staff.display_name != name:
                staff.display_name = name
