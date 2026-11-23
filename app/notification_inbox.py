"""User-scoped, non-destructive inbox, separate from Telegram delivery state."""
from datetime import datetime, timezone
from html import unescape
import re

from sqlalchemy import text
from .db import Session, NotificationDelivery
from .notification_outbox import delivery_message


_ROWS = """
WITH deliveries AS (
 SELECT DISTINCT ON (COALESCE(event_id, 'delivery:' || id::text))
   'd:' || id::text AS key, id, created_at, 'delivery' AS kind
 FROM notification_deliveries
 WHERE recipient_id = :uid AND created_at <= now()
   AND (cancelled_at IS NULL OR event = 'return_overdue_customer')
   AND (event = 'return_overdue_customer' OR next_retry_at IS NULL OR next_retry_at <= now() OR sent_at IS NOT NULL)
 ORDER BY COALESCE(event_id, 'delivery:' || id::text), id DESC
), support AS (
 SELECT 's:' || m.id::text AS key, m.id, m.created_at, 'support' AS kind
 FROM support_messages m JOIN support_threads t ON t.id=m.thread_id
 WHERE (m.direction='operator' AND t.customer_id=:uid)
    OR (m.direction='client' AND t.owner_id=:uid)
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


def inbox(uid, offset=0, limit=10):
    with Session.begin() as session:
        _initialize(session, uid)
        params = {"uid": uid, "offset": offset, "limit": limit + 1}
        unread = session.scalar(text(_ROWS + """SELECT EXISTS (SELECT 1 FROM all_rows n
          JOIN notification_inbox_users u ON u.recipient_id=:uid
          LEFT JOIN notification_inbox_reads r ON r.recipient_id=:uid AND r.notification_key=n.key
          WHERE n.created_at > u.initialized_at AND r.notification_key IS NULL)"""), params)
        rows = session.execute(text(_ROWS + "SELECT * FROM all_rows ORDER BY created_at DESC, key DESC OFFSET :offset LIMIT :limit"), params).mappings().all()
        items = []
        for row in rows[:limit]:
            if row["kind"] == "support":
                message = "Новое сообщение в поддержке"
            else:
                delivery = session.get(NotificationDelivery, row["id"])
                try:
                    message = unescape(re.sub(r"<[^>]*>", "", delivery_message(delivery)))
                except (ValueError, TypeError):
                    message = "Новое уведомление"
            kind = "support" if row["kind"] == "support" else "booking" if delivery.booking_id else "notification"
            item = {"id": row["key"], "message": message, "created_at": row["created_at"].isoformat(),
                    **_presentation(message, kind)}
            if kind == "booking" and delivery.return_due_at is not None:
                item["booking_id"] = delivery.booking_id
                item["staff"] = delivery.event != "return_overdue_customer"
            items.append(item)
        return {"items": items, "unread": bool(unread), "has_more": len(rows) > limit}


def mark_read(uid, keys):
    with Session.begin() as session:
        _initialize(session, uid)
        allowed = set(session.scalars(text(_ROWS + "SELECT key FROM all_rows WHERE key = ANY(:keys)"), {"uid": uid, "keys": keys}))
        for key in allowed:
            session.execute(text("INSERT INTO notification_inbox_reads(recipient_id,notification_key) VALUES (:uid,:key) ON CONFLICT DO NOTHING"), {"uid": uid, "key": key})
