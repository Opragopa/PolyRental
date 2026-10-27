"""Queue each overdue escalation once, without personal data in messages."""
import os
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from .db import Audit, Booking, NotificationDelivery, OperatorNotificationPreference, Session, SlaEscalation
from .request_sla import request_sla
from .roles import configured_ids
from .operator_preferences import next_actionable_time
from .sla_clock import add_business_time


def queue_sla_escalations(at=None):
    at = at or datetime.now(timezone.utc)
    raw_chat = os.getenv('SLA_SHARED_CHAT_ID', '').strip()
    shared = int(raw_chat) if raw_chat and raw_chat.lstrip('-').isdigit() and int(raw_chat) != 0 else None
    admins = sorted(configured_ids('ADMIN_IDS'))
    queued, cursor = 0, 0
    while True:
        with Session.begin() as session:
            bookings = session.scalars(select(Booking).where(
                Booking.id > cursor, Booking.deleted_at.is_(None), Booking.status.in_(['pending', 'confirmed', 'preparing', 'ready', 'issued', 'return_inspection']),
                Booking.sla_closed_at.is_(None)).order_by(Booking.id).limit(200).with_for_update(skip_locked=True)).all()
            if not bookings:
                break
            cursor = bookings[-1].id
            for booking in bookings:
                state = request_sla(booking, at)
                number = booking.human_number or f'№{booking.id}'
                events = []
                if state['breached'] and shared:
                    kind = 'resolve_shared' if state['stage'] == 'resolve' else 'claim_shared'
                    wording = 'просрочено' if state['stage'] == 'resolve' else 'заявка не взята'
                    events.append((kind, [shared], f'Заявка {number}: {wording}.'))
                if state['admin_breached'] and admins:
                    kind = 'resolve_admin' if state['stage'] == 'resolve' else 'unclaimed_admin'
                    events.append((kind, admins, f'Заявка {number}: требуется внимание администратора.'))
                for tier, recipients, message in events:
                    if session.get(SlaEscalation, (booking.id, tier, booking.sla_cycle)) is not None:
                        continue
                    session.add(SlaEscalation(booking_id=booking.id, tier=tier, cycle=booking.sla_cycle))
                    session.add(Audit(booking_id=booking.id, actor_id=0, action=f'sla_{tier}'))
                    for recipient in recipients:
                        pref = session.get(OperatorNotificationPreference, recipient) if not tier.endswith('_shared') else None
                        settings = {'quiet_start': pref.quiet_start if pref else None, 'quiet_end': pref.quiet_end if pref else None}
                        due = (add_business_time(at, timedelta(microseconds=1)) if tier.endswith('_shared')
                               else next_actionable_time(recipient, at, settings))
                        session.add(NotificationDelivery(booking_id=booking.id, recipient_id=recipient,
                                                         event=f'sla_{tier}', message=message, next_retry_at=due))
                    queued += 1
    return queued
