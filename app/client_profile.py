"""Server-side client entry and non-PII activity tracking."""
from sqlalchemy import select, text
from .db import Booking, ClientActivity, ClientProfile, Session


def profile_state(user_id):
    with Session.begin() as session:
        session.execute(text("INSERT INTO client_profiles (telegram_id, created_at) VALUES (:id, COALESCE((SELECT MIN(created_at) FROM bookings WHERE customer_id=:id), now())) ON CONFLICT DO NOTHING"), {"id": user_id})
        profile = session.get(ClientProfile, user_id)
        contact = session.scalar(select(Booking.customer_contact).where(Booking.customer_id == user_id)
                                 .order_by(Booking.created_at.desc(), Booking.id.desc()).limit(1))
        return {"member_since": profile.created_at.isoformat(), "onboarding_seen": profile.onboarding_shown_at is not None,
                "contact": contact or ""}


def mark_onboarding_shown(user_id):
    with Session.begin() as session:
        session.execute(text("INSERT INTO client_profiles (telegram_id, created_at) VALUES (:id, COALESCE((SELECT MIN(created_at) FROM bookings WHERE customer_id=:id), now())) ON CONFLICT DO NOTHING"), {"id": user_id})
        changed = session.execute(text("UPDATE client_profiles SET onboarding_shown_at=now() WHERE telegram_id=:id AND onboarding_shown_at IS NULL RETURNING telegram_id"), {"id": user_id}).scalar_one_or_none()
        if changed:
            session.add(ClientActivity(telegram_id=user_id, action="onboarding_first_shown"))
        return bool(changed)


def complete_onboarding(user_id):
    with Session.begin() as session:
        session.execute(text("INSERT INTO client_profiles (telegram_id, created_at) VALUES (:id, COALESCE((SELECT MIN(created_at) FROM bookings WHERE customer_id=:id), now())) ON CONFLICT DO NOTHING"), {"id": user_id})
        changed = session.execute(text("UPDATE client_profiles SET onboarding_completed_at=now() WHERE telegram_id=:id AND onboarding_completed_at IS NULL RETURNING telegram_id"), {"id": user_id}).scalar_one_or_none()
        if changed:
            session.add(ClientActivity(telegram_id=user_id, action="onboarding_completed"))


def record_client_mode(user_id):
    with Session.begin() as session:
        session.add(ClientActivity(telegram_id=user_id, action="operator_client_mode"))
