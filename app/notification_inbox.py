"""User-scoped, non-destructive inbox, separate from Telegram delivery state."""
from datetime import datetime, timezone
from html import unescape
import re

from cryptography.exceptions import InvalidTag
from sqlalchemy import and_, or_, select, text
from .db import NotificationDelivery, PIIAudit, Session, SupportMessage, SupportThread
from .notification_outbox import delivery_message
from .return_overdue import RETURN_EVENTS, RISK_EVENT
from .support import _open, operator_can_read


_ROWS = """
WITH deliveries AS (
 SELECT DISTINCT ON (COALESCE(event_id, 'delivery:' || id::text))
   'd:' || id::text AS key, id, created_at, 'delivery' AS kind,
   NULL::integer AS thread_id, NULL::text AS request_number, NULL::text AS direction, NULL::integer AS booking_id
 FROM notification_deliveries
 WHERE recipient_id = :uid AND created_at <= now()
   AND (cancelled_at IS NULL OR event = 'return_overdue_customer')
   AND (event = 'return_overdue_customer' OR next_retry_at IS NULL OR next_retry_at <= now() OR sent_at IS NOT NULL)
 ORDER BY COALESCE(event_id, 'delivery:' || id::text), id DESC
), support AS (
 SELECT 's:' || m.id::text AS key, m.id, m.created_at, 'support' AS kind,
        t.id AS thread_id, t.request_number, m.direction, t.booking_id
 FROM support_messages m JOIN support_threads t ON t.id=m.thread_id
 WHERE (m.direction='operator' AND t.customer_id=:uid)
    OR (m.direction='client' AND t.owner_id=:uid AND :may_read_support)
), all_rows AS (SELECT * FROM deliveries UNION ALL SELECT * FROM support)
"""


def _initialize(session, uid):
    session.execute(text("INSERT INTO notification_inbox_users(recipient_id) VALUES (:uid) ON CONFLICT DO NOTHING"), {"uid": uid})


def _presentation(message, kind):
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    # Telegram navigation and attribution are not notification content.
    content = [line for line in lines if not line.startswith(("Автор:", "Открыть заявку"))]
    if kind == "support":
        return {"title": "Поддержка", "summary": message, "kind": kind}
    if not content:
        return {"title": "Уведомление", "summary": "", "kind": kind}
    title, *body = content
    # Older card deliveries contain the entire rental inventory. In the inbox
    # the booking number and its status are sufficient to identify the update.
    if any(line.startswith("Создана:") for line in body):
        body = [line.removeprefix("Статус:").strip() for line in body if line.startswith("Статус:")]
    return {"title": title, "summary": " ".join(body), "kind": kind}


def inbox(uid, offset=0, limit=10, support_preview=False):
    with Session.begin() as session:
        _initialize(session, uid)
        params = {"uid": uid, "offset": offset, "limit": limit + 1, "may_read_support": operator_can_read(uid)}
        unread = session.scalar(text(_ROWS + """SELECT count(*) FROM all_rows n
          JOIN notification_inbox_users u ON u.recipient_id=:uid
          LEFT JOIN notification_inbox_reads r ON r.recipient_id=:uid AND r.notification_key=n.key
          WHERE n.created_at > u.initialized_at AND r.notification_key IS NULL"""), params)
        rows = session.execute(text(_ROWS + """SELECT n.*, n.created_at > u.initialized_at AND r.notification_key IS NULL AS unread
          FROM all_rows n JOIN notification_inbox_users u ON u.recipient_id=:uid
          LEFT JOIN notification_inbox_reads r ON r.recipient_id=:uid AND r.notification_key=n.key
          ORDER BY n.created_at DESC, n.key DESC OFFSET :offset LIMIT :limit"""), params).mappings().all()
        items = []
        for row in rows[:limit]:
            if row["kind"] == "support":
                staff = row["direction"] == "client"
                item = {
                    "id": row["key"], "kind": "support", "tone": "support", "unread": row["unread"],
                    "message": "Новое сообщение в поддержке",
                    "title": "Сообщение от клиента" if staff else "Ответ оператора",
                    "summary": f"Обращение №{row['thread_id']}" + (f" · {row['request_number']}" if row["request_number"] else ""),
                    "created_at": row["created_at"].isoformat(), "staff": staff,
                    "support_thread_id": row["thread_id"], "support_message_id": row["id"], "booking_id": row["booking_id"],
                }
                if support_preview:
                    try:
                        body = _support_text(session, uid, row["id"], params["may_read_support"])
                    except (InvalidTag, ValueError):
                        body = None
                    if body:
                        excerpt = " ".join(body.split())
                        item["preview"] = excerpt[:100].rstrip() + ("…" if len(excerpt) > 100 else "")
                items.append(item)
                continue
            else:
                delivery = session.get(NotificationDelivery, row["id"])
                try:
                    message = unescape(re.sub(r"<[^>]*>", "", delivery_message(delivery)))
                except (ValueError, TypeError):
                    message = "Новое уведомление"
            kind = "support" if delivery.event == "support_action" else "booking" if delivery.booking_id else "notification"
            item = {"id": row["key"], "message": message, "created_at": row["created_at"].isoformat(),
                    "unread": row["unread"], "tone": "urgent" if delivery.event in RETURN_EVENTS | {RISK_EVENT} else kind,
                    **_presentation(message, kind)}
            if kind == "booking" and delivery.return_due_at is not None:
                item["booking_id"] = delivery.booking_id
                item["staff"] = delivery.event != "return_overdue_customer"
            items.append(item)
        return {"items": items, "unread": bool(unread), "unread_count": unread, "has_more": len(rows) > limit}


def mark_read(uid, keys):
    with Session.begin() as session:
        _initialize(session, uid)
        params = {"uid": uid, "keys": keys, "may_read_support": operator_can_read(uid)}
        allowed = set(session.scalars(text(_ROWS + "SELECT key FROM all_rows WHERE key = ANY(:keys)"), params))
        for key in allowed:
            session.execute(text("INSERT INTO notification_inbox_reads(recipient_id,notification_key) VALUES (:uid,:key) ON CONFLICT DO NOTHING"), {"uid": uid, "key": key})


def _support_text(session, uid, message_id, may_read_support):
    staff_access = and_(SupportThread.owner_id == uid, SupportMessage.direction == "client") if may_read_support else False
    row = session.execute(select(SupportMessage, SupportThread).join(SupportThread).where(
        SupportMessage.id == message_id, or_(
            and_(SupportThread.customer_id == uid, SupportMessage.direction == "operator"), staff_access
        ))).first()
    if row is None:
        return None
    message, thread = row
    body = _open(message)
    if message.direction == "client":
        session.add(PIIAudit(booking_id=thread.booking_id, actor_id=uid, action="support_read"))
    return body


def support_detail(uid, message_id):
    with Session.begin() as session:
        try:
            return _support_text(session, uid, message_id, operator_can_read(uid))
        except (InvalidTag, ValueError):
            return None
