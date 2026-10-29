"""Durable Telegram notification delivery with retry and an operator-visible log."""

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from .db import Booking, NotificationDelivery, Session


logger = logging.getLogger(__name__)
MAX_BACKOFF_SECONDS = 30 * 60


def encrypt_message(booking_id, recipient_id, event, message):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from .pii import _master_key
    nonce=os.urandom(12)
    body=AESGCM(_master_key()).encrypt(nonce,message.encode(),f"notification:{booking_id}:{recipient_id}:{event[:50]}".encode())
    return "enc-v1:"+base64.urlsafe_b64encode(nonce+body).decode()


def delivery_message(delivery):
    if not delivery.message.startswith("enc-v1:"): return delivery.message
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from .pii import _master_key
    raw=base64.urlsafe_b64decode(delivery.message[7:])
    return AESGCM(_master_key()).decrypt(raw[:12],raw[12:],f"notification:{delivery.booking_id}:{delivery.recipient_id}:{delivery.event}".encode()).decode()


def _now():
    return datetime.now(timezone.utc)


def enqueue_notification(booking_id: int | None, recipient_id: int, event: str, message: str, due=None) -> int:
    """Write before delivery so a process restart cannot silently lose a message."""
    with Session.begin() as session:
        existing_booking_id = booking_id if booking_id is not None and session.get(Booking, booking_id) else None
        delivery = NotificationDelivery(booking_id=existing_booking_id, recipient_id=recipient_id,
                                        event=event[:50], message=message, next_retry_at=due or _now())
        session.add(delivery)
        session.flush()
        return delivery.id


async def deliver_notification(delivery_id: int) -> bool:
    """Serialize attempts per outbox row; record failures without message content."""
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return False
    with Session.begin() as session:
        delivery = session.scalar(select(NotificationDelivery).where(
            NotificationDelivery.id == delivery_id).with_for_update(skip_locked=True))
        if delivery is None:
            return False
        if delivery.sent_at is not None or delivery.cancelled_at is not None:
            return delivery.cancelled_at is None
        if delivery.event.startswith("optional_reminder_"):
            from .db import ClientProfile
            booking=session.get(Booking,delivery.booking_id)
            profile=session.get(ClientProfile,delivery.recipient_id)
            returning="_return_" in delivery.event
            valid=({"issued"} if returning else {"confirmed","preparing","ready"})
            moment=(booking.ends_at if returning else booking.starts_at) if booking else None
            if not booking or booking.deleted_at or booking.status not in valid or moment<=_now() or (profile and not profile.reminders_enabled):
                delivery.cancelled_at=_now()
                return False
        try:
            from .bot import make_bot
            from aiogram.enums import ParseMode
            async with make_bot(token) as bot:
                await asyncio.wait_for(bot.send_message(delivery.recipient_id, delivery_message(delivery), parse_mode=ParseMode.HTML), timeout=10)
        except Exception as exc:
            delivery.attempts += 1
            delay = min(2 ** min(delivery.attempts, 10), MAX_BACKOFF_SECONDS)
            delivery.last_error = type(exc).__name__
            delivery.next_retry_at = _now() + timedelta(seconds=delay)
            logger.warning("Telegram notification %s failed (%s); retry scheduled", delivery_id, type(exc).__name__)
            return False
        delivery.attempts += 1
        delivery.last_error = None
        delivery.next_retry_at = None
        delivery.sent_at = _now()
        return True


async def notify(booking_id: int | None, recipient_id: int, event: str, message: str) -> bool:
    """Enqueue first, then make the low-latency attempt requested by the workflow."""
    if not os.getenv("BOT_TOKEN", ""):
        return False
    delivery_id = await asyncio.to_thread(enqueue_notification, booking_id, recipient_id, event, message)
    return await deliver_notification(delivery_id)


async def notify_actionable(booking_id: int | None, recipient_id: int, event: str, message: str) -> bool:
    """Persist immediately, but deliver after the recipient's quiet hours."""
    if not os.getenv("BOT_TOKEN", ""):
        return False
    from .operator_preferences import next_actionable_time
    current = _now()
    due = await asyncio.to_thread(next_actionable_time, recipient_id, current)
    delivery_id = await asyncio.to_thread(enqueue_notification, booking_id, recipient_id, event, message, due)
    if due > current + timedelta(seconds=1):
        return True
    return await deliver_notification(delivery_id)


def pending_notification_ids(limit=100):
    with Session() as session:
        return session.scalars(select(NotificationDelivery.id).where(
            NotificationDelivery.sent_at.is_(None), NotificationDelivery.cancelled_at.is_(None),
            or_(NotificationDelivery.next_retry_at.is_(None), NotificationDelivery.next_retry_at <= _now())
        ).order_by(NotificationDelivery.id).limit(limit)).all()


async def retry_pending_notifications():
    """Run from the application lifecycle; failed rows retain their complete history."""
    for delivery_id in await asyncio.to_thread(pending_notification_ids):
        await deliver_notification(delivery_id)
