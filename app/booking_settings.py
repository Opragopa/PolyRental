"""Shared booking question settings, independent of pickup instructions."""
from sqlalchemy.dialects.postgresql import insert

from .db import BookingSettings, Session


def get_booking_settings():
    with Session() as session:
        row = session.get(BookingSettings, 1)
        return {"rental_purpose_enabled": row.rental_purpose_enabled if row else True}


def save_booking_settings(actor_id, rental_purpose_enabled):
    from .inventory import require_role
    require_role(actor_id, "admin")
    if type(rental_purpose_enabled) is not bool:
        raise ValueError("Укажите, включён ли вопрос о цели аренды")
    with Session.begin() as session:
        session.execute(insert(BookingSettings).values(
            id=1, rental_purpose_enabled=rental_purpose_enabled
        ).on_conflict_do_update(index_elements=[BookingSettings.id], set_={
            "rental_purpose_enabled": rental_purpose_enabled,
        }))
    return {"rental_purpose_enabled": rental_purpose_enabled}


def normalize_rental_purpose(value):
    if not isinstance(value, str) or len(value) > 2000:
        raise ValueError("Цель аренды — текст до 2000 символов")
    return value.strip()
