"""Quiet hours delay actionable messages without disabling them."""
from datetime import datetime, time, timedelta
from sqlalchemy import text
from .db import OperatorNotificationPreference, Session
from .sla_clock import MOSCOW, add_business_time


def preferences(user_id):
    with Session() as session:
        row = session.get(OperatorNotificationPreference, user_id)
        return {'quiet_start': row.quiet_start if row else None, 'quiet_end': row.quiet_end if row else None}


def save_preferences(user_id, start, end):
    if (start is None) != (end is None) or (start is not None and start == end):
        raise ValueError('Укажите начало и конец тихих часов либо оставьте оба поля пустыми')
    if start is not None:
        try:
            for value in (start, end):
                if len(value) != 5 or time.fromisoformat(value).strftime('%H:%M') != value:
                    raise ValueError()
        except (ValueError, TypeError):
            raise ValueError('Укажите время в формате ЧЧ:ММ') from None
    with Session.begin() as session:
        session.execute(text('INSERT INTO operator_notification_preferences (telegram_id) VALUES (:id) ON CONFLICT DO NOTHING'), {'id':user_id})
        row = session.get(OperatorNotificationPreference, user_id, with_for_update=True)
        row.quiet_start, row.quiet_end = start, end


def next_actionable_time(user_id, at, setting=None):
    local = at.astimezone(MOSCOW)
    if setting is None:
        setting = preferences(user_id)
    if setting['quiet_start'] is None:
        return add_business_time(local, timedelta(microseconds=1))
    start, end = time.fromisoformat(setting['quiet_start']), time.fromisoformat(setting['quiet_end'])
    current = local.timetz().replace(tzinfo=None)
    in_quiet = start <= current < end if start < end else current >= start or current < end
    if not in_quiet:
        return local
    next_day = local.date() + timedelta(days=1) if start > end and current >= start else local.date()
    return datetime.combine(next_day, end, MOSCOW)
