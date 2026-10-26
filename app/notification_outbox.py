"""Durable Telegram notification delivery with retry and an operator-visible log."""

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from .db import Booking, NotificationDelivery, Session


logger = logging.getLogger(__name__)
MAX_BACKOFF_SECONDS = 30 * 60


def _now():
    return datetime.now(timezone.utc)


def enqueue_notification(booking_id: int | None, recipient_id: int, event: str, message: str) -> int:
    """Write before delivery so a process restart cannot silently lose a message."""
    with Session.begin() as session:
        existing_booking_id = booking_id if booking_id is not None and session.get(Booking, booking_id) else None
        delivery = NotificationDelivery(booking_id=existing_booking_id, recipient_id=recipient_id,
                                        event=event[:50], message=message, next_retry_at=_now())
        session.add(delivery)
        session.flush()
        return delivery.id


async def deliver_notification(delivery_id: int) -> bool:
    """Attempt one send and persist either success or the reason and retry time."""
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return False
    with Session() as session:
        delivery = session.get(NotificationDelivery, delivery_id)
        if delivery is None or delivery.sent_at is not None:
            return delivery is not None
        recipient_id, message = delivery.recipient_id, delivery.message
    try:
        from .bot import make_bot
        from aiogram.enums import ParseMode
        async with make_bot(token) as bot:
            await bot.send_message(recipient_id, message, parse_mode=ParseMode.HTML)
    except Exception as exc:  # Telegram and network failures must remain observable and retriable.
        error = f"{type(exc).__name__}: {exc}"[:1000]
        with Session.begin() as session:
            delivery = session.get(NotificationDelivery, delivery_id, with_for_update=True)
            if delivery is None or delivery.sent_at is not None:
                return delivery is not None
            delivery.attempts += 1
            delay = min(2 ** min(delivery.attempts, 10), MAX_BACKOFF_SECONDS)
            delivery.last_error = error
            delivery.next_retry_at = _now() + timedelta(seconds=delay)
        logger.warning("Telegram notification %s to %s failed (will retry): %s",
                       delivery_id, recipient_id, error)
        return False
    with Session.begin() as session:
        delivery = session.get(NotificationDelivery, delivery_id, with_for_update=True)
        if delivery is not None:
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


def pending_notification_ids(limit=100):
    with Session() as session:
        return session.scalars(select(NotificationDelivery.id).where(
            NotificationDelivery.sent_at.is_(None),
            or_(NotificationDelivery.next_retry_at.is_(None), NotificationDelivery.next_retry_at <= _now())
        ).order_by(NotificationDelivery.id).limit(limit)).all()


async def retry_pending_notifications():
    """Run from the application lifecycle; failed rows retain their complete history."""
    for delivery_id in await asyncio.to_thread(pending_notification_ids):
        await deliver_notification(delivery_id)
