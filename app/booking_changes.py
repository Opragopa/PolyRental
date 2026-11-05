"""Encrypted request changes, optimistic responses and durable deadline notifications."""
from datetime import datetime, timedelta, timezone
from html import escape
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, delete

from .db import (Audit, Booking, BookingAsset, BookingChange, BookingLine, BookingOperationLease,
                 NotificationDelivery, Session)
from .pii import _master_key
from .rental import Conflict, _normalize_lines, validate_interval
from .inventory import require_role


def now():
    return datetime.now(timezone.utc)


def _decode(change):
    if not change.ciphertext:
        return {"before":{},"after":{},"comment":"Содержимое удалено по сроку хранения"}
    return json.loads(AESGCM(_master_key()).decrypt(change.nonce, change.ciphertext,
                     f"booking-change:{change.booking_id}".encode()))


def _snapshot(booking):
    return {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(),
            "lines": sorted([{"article_id": row.article_id, "quantity": row.quantity,"name":row.article.name} for row in booking.lines], key=lambda row: row["article_id"])}


def queue(session, booking, event, message, recipient=None, sensitive=False):
    if sensitive:
        from .notification_outbox import encrypt_message
        message=encrypt_message(booking.id,recipient or booking.customer_id,event,message)
    session.add(NotificationDelivery(booking_id=booking.id, recipient_id=recipient or booking.customer_id,
                                     event=event, message=message, next_retry_at=now()))


def _save_history(session, booking, audit, before, after, change=None):
    """Bind an encrypted comparison to the exact audit event, without a migration."""
    session.add(audit)
    session.flush()
    if change is None:
        change = BookingChange(booking_id=booking.id, actor_id=audit.actor_id,
                               change_type="customer_edit", status="accepted")
        payload = {"before": before, "after": after}
        session.add(change)
    else:
        payload = _decode(change)
    payload.setdefault("history", {})[str(audit.id)] = {"before": before, "after": after}
    change.nonce = os.urandom(12)
    change.ciphertext = AESGCM(_master_key()).encrypt(change.nonce,
        json.dumps(payload, ensure_ascii=False).encode(), f"booking-change:{booking.id}".encode())
    from .booking_diff import comparison
    session.info.setdefault("booking_change_details", {})[booking.id] = comparison(before, after)


def decline_request(booking_id, actor_id, comment, expected_before=None):
    require_role(actor_id,"manager")
    if not comment.strip() or len(comment)>2000:
        raise ValueError("Укажите причину отклонения до 2000 символов")
    from .db import CustomerIdentity
    with Session.begin() as session:
        booking=session.get(Booking,booking_id,with_for_update=True)
        if not booking or booking.deleted_at: raise ValueError("Заявка не найдена")
        if booking.status not in {"pending","needs_changes","confirmed"}:
            raise Conflict("Отклонение доступно до начала подготовки")
        if expected_before is not None and _snapshot(booking) != expected_before:
            raise Conflict("Заявка изменилась. Откройте её заново")
        from .customer_changes import obsolete_request
        obsolete_request(session, booking)
        nonce=os.urandom(12)
        payload={"before":_snapshot(booking),"after":_snapshot(booking),"comment":comment.strip()}
        session.add(BookingChange(booking_id=booking_id,actor_id=actor_id,change_type="rejected",status="rejected",
            nonce=nonce,ciphertext=AESGCM(_master_key()).encrypt(nonce,json.dumps(payload,ensure_ascii=False).encode(),f"booking-change:{booking_id}".encode())))
        booking.status,booking.assignee_id,booking.sla_closed_at="cancelled",None,now()
        booking.identity_status="not_required"
        identity=session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id==booking_id))
        if identity: identity.delete_after=now()+timedelta(hours=24)
        session.execute(delete(BookingOperationLease).where(BookingOperationLease.booking_id==booking_id))
        session.add(Audit(booking_id=booking_id,actor_id=actor_id,action="request_rejected"))
        queue(session,booking,"request_rejected",f"Заявка {escape(booking.human_number or str(booking_id))} отклонена. Причина: {escape(comment.strip())}",sensitive=True)


def propose_change(booking_id, actor_id, change_type, comment, proposed=None, expected_before=None):
    require_role(actor_id, "manager")
    if change_type not in {"client_fix", "manager_edit"} or not comment.strip() or len(comment) > 2000:
        raise ValueError("Укажите тип изменения и обязательный комментарий до 2000 символов")
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.deleted_at:
            raise ValueError("Заявка не найдена")
        if booking.status not in {"pending", "confirmed"}:
            raise Conflict("Изменения заявки доступны до начала подготовки")
        before = _snapshot(booking)
        if expected_before is not None and before != expected_before:
            raise Conflict("Заявка изменилась во время редактирования. Откройте её заново")
        from .customer_changes import obsolete_request
        obsolete_request(session, booking)
        after = proposed or before
        if change_type == "manager_edit":
            start, end = datetime.fromisoformat(after["start"]), datetime.fromisoformat(after["end"])
            validate_interval(start, end, enforce_booking_notice=True)
            normalized = _normalize_lines(session, after["lines"])
            after = {"start": start.isoformat(), "end": end.isoformat(),
                     "lines": [{"article_id": row[0].id, "quantity": row[1],"name":row[0].name} for row in normalized]}
        nonce = os.urandom(12)
        encrypted = AESGCM(_master_key()).encrypt(nonce,
            json.dumps({"before": before, "after": after, "comment": comment.strip()}, ensure_ascii=False).encode(),
            f"booking-change:{booking.id}".encode())
        change = BookingChange(booking_id=booking.id, actor_id=actor_id, change_type=change_type,
            status="pending", ciphertext=encrypted, nonce=nonce,
            deadline=now() + timedelta(hours=24) if change_type == "manager_edit" else None)
        session.add(change)
        booking.status = "needs_changes"
        booking.hold_expires_at = None
        session.execute(delete(BookingOperationLease).where(BookingOperationLease.booking_id == booking.id))
        _save_history(session, booking,
            Audit(booking_id=booking.id, actor_id=actor_id, action="request_changes_proposed"), before, after, change)
        queue(session, booking, "request_changes", f"Заявка {escape(booking.human_number or str(booking.id))}: откройте Mini App, чтобы {'подтвердить изменения в течение 24 часов' if change_type == 'manager_edit' else 'исправить заявку'}. Комментарий доступен в приложении.")
        session.flush()
        return change.id


def change_view(booking_id, actor_id, pii=False):
    with Session() as session:
        booking = session.get(Booking, booking_id)
        if not booking:
            raise ValueError("Заявка не найдена")
        if booking.customer_id != actor_id:
            require_role(actor_id)
        change = session.scalar(select(BookingChange).where(BookingChange.booking_id == booking_id)
                                .order_by(BookingChange.id.desc()).limit(1))
        if change is None:
            return None
        payload = _decode(change)
        history = payload.pop("history", {})
        if change.status == "accepted" and history:
            payload.update(history[max(history, key=int)])
        if booking.customer_id != actor_id and not pii:
            payload.pop("comment", None)
            payload.pop("dispute", None)
        return {"id": change.id, "change_type": change.change_type, "status": change.status,
                "deadline": change.deadline.isoformat() if change.deadline else None, **payload}


def update_request(booking_id, customer_id, start, end, lines, change_id=None, accept=True, comment="", expected_before=None):
    """A response is bound to the exact proposal; replay never applies a newer edit."""
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.customer_id != customer_id or booking.deleted_at:
            raise ValueError("Заявка не найдена")
        if booking.status not in {"pending", "needs_changes"}:
            raise Conflict("Редактирование доступно до подтверждения")
        if expected_before is not None and _snapshot(booking) != expected_before:
            raise Conflict("Заявка изменилась во время редактирования. Откройте её заново")
        before = _snapshot(booking)
        change = session.scalar(select(BookingChange).where(BookingChange.booking_id == booking.id)
                                .order_by(BookingChange.id.desc()).limit(1))
        if change_id is not None:
            if not change or change.id != change_id or change.status != "pending" or booking.status != "needs_changes":
                raise Conflict("Изменение уже обработано; обновите заявку")
            if not change.ciphertext:
                raise Conflict("Содержимое изменения удалено; обратитесь к менеджеру")
            if change.deadline and change.deadline <= now():
                raise Conflict("Срок ответа истёк; решение принимает менеджер")
            if not accept:
                if not comment.strip() or len(comment) > 2000:
                    raise ValueError("Для оспаривания нужен комментарий до 2000 символов")
                payload = _decode(change)
                payload["dispute"] = comment.strip()
                change.nonce = os.urandom(12)
                change.ciphertext = AESGCM(_master_key()).encrypt(change.nonce, json.dumps(payload).encode(),
                    f"booking-change:{booking.id}".encode())
                change.status = "disputed"
                booking.status = "pending"
                queue(session, booking, "request_disputed", f"Изменения заявки {escape(booking.human_number or str(booking.id))} оспорены. Комментарий доступен уполномоченному сотруднику в Mini App.", change.actor_id)
                session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="request_changes_disputed"))
                return
            if change.change_type == "manager_edit":
                after = _decode(change)["after"]
                start, end, lines = datetime.fromisoformat(after["start"]), datetime.fromisoformat(after["end"]), after["lines"]
        elif booking.status == "needs_changes":
            raise Conflict("Ответьте на актуальный запрос изменений")
        if start is None or end is None or lines is None:
            raise ValueError("Передайте исправленные даты и оборудование")
        validate_interval(start, end, enforce_booking_notice=True)
        normalized = _normalize_lines(session, lines)
        from .rental import _capacity, _reserved_quantity
        from sqlalchemy import text
        for article, quantity, *_ in sorted(normalized, key=lambda row: row[0].id):
            session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id":article.id})
            session.refresh(article)
            if not article.is_active or article.archived_at is not None:
                raise Conflict("Один из артикулов больше недоступен")
            if _capacity(session,article.id) - _reserved_quantity(session,article.id,start,end,exclude_booking_id=booking.id) < quantity:
                raise Conflict(f"Недостаточно свободных единиц: {article.name}")
        # Reuse line IDs, including hidden rows, to preserve the unique article key.
        session.execute(delete(BookingAsset).where(BookingAsset.booking_id == booking.id))
        existing = {row.article_id: row for row in session.scalars(select(BookingLine).where(BookingLine.booking_id == booking.id))}
        selected = {row[0].id for row in normalized}
        for article_id, row in existing.items():
            if article_id not in selected:
                row.deleted_at = now()
        for article, quantity, rate, auto_added, billable in normalized:
            article_id = article.id
            row = existing.get(article_id)
            if row is None:
                row = BookingLine(booking_id=booking.id, article_id=article_id)
                session.add(row)
            row.quantity, row.billable_quantity, row.hourly_rate = quantity, 0, 0
            row.auto_added, row.deleted_at = auto_added, None
        booking.starts_at, booking.ends_at, booking.status = start, end, "pending"
        if change_id is not None:
            change.status = "accepted"
            queue(session, booking, "request_changes_answered", f"Клиент подтвердил изменения заявки {escape(booking.human_number or str(booking.id))}. Проверьте доступность и подтвердите заявку.", change.actor_id)
        after = {"start": start.isoformat(), "end": end.isoformat(),
                 "lines": [{"article_id": row[0].id, "quantity": row[1], "name": row[0].name} for row in normalized]}
        _save_history(session, booking,
            Audit(booking_id=booking.id, actor_id=customer_id, action="request_updated"),
            before, after, change if change_id is not None else None)


def process_change_deadlines(at=None):
    timestamp = at or now()
    count = 0
    with Session.begin() as session:
        ids = session.scalars(select(BookingChange.booking_id).where(
            BookingChange.status == "pending", BookingChange.change_type == "manager_edit",
            BookingChange.deadline <= timestamp + timedelta(hours=2)).order_by(BookingChange.booking_id)).all()
        for booking_id in sorted(set(ids)):
            booking = session.get(Booking, booking_id, with_for_update=True)
            change = session.scalar(select(BookingChange).where(BookingChange.booking_id == booking_id)
                                    .order_by(BookingChange.id.desc()).limit(1))
            if not booking or booking.deleted_at or booking.status != "needs_changes" or change.status != "pending":
                continue
            if change.deadline <= timestamp:
                change.status, booking.status = "unanswered", "pending"
                queue(session, booking, "request_unanswered", f"Клиент не ответил на изменения заявки {escape(booking.human_number or str(booking.id))}. Требуется решение менеджера.", change.actor_id)
                session.add(Audit(booking_id=booking.id, actor_id=0, action="request_changes_unanswered"))
                count += 1
            elif change.reminded_at is None:
                change.reminded_at = timestamp
                queue(session, booking, "request_change_reminder", f"До окончания срока подтверждения изменений заявки {escape(booking.human_number or str(booking.id))} осталось не более 2 часов. Откройте Mini App.")
        return count
