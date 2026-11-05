"""Permission to edit after confirmation, serialized with preparation."""
from datetime import datetime, timezone
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, select

from .db import Audit, Booking, BookingChange, BookingOperationLease, CustomerChangeRequest, Session
from .inventory import require_role
from .pii import _master_key
from .rental import Conflict
from .roles import staff_allows


def now():
    return datetime.now(timezone.utc)


def latest_request(session, booking_id):
    return session.scalar(select(CustomerChangeRequest).where(CustomerChangeRequest.booking_id == booking_id)
                          .order_by(CustomerChangeRequest.id.desc()).limit(1))


def can_request(booking, request=None):
    return (not booking.deleted_at and booking.status == "confirmed"
            and booking.identity_status in {"submitted", "verified"}
            and (request is None or request.status != "pending"))


def summary(row):
    return {"id": row.id, "status": row.status, "created_at": row.created_at.isoformat(),
            "decided_at": row.decided_at.isoformat() if row.decided_at else None} if row else None


def request_overview(booking):
    with Session() as session:
        row = latest_request(session, booking.id)
        return {"can_request": can_request(booking, row), "request": summary(row)}


def _seal(row, payload):
    row.nonce = os.urandom(12)
    row.ciphertext = AESGCM(_master_key()).encrypt(row.nonce, json.dumps(payload, ensure_ascii=False).encode(),
                                                f"customer-change:{row.booking_id}".encode())


def _open(row):
    if not row.ciphertext:
        return {"reason": "Причина удалена по сроку хранения", "decision_comment": ""}
    return json.loads(AESGCM(_master_key()).decrypt(row.nonce, row.ciphertext,
                                                   f"customer-change:{row.booking_id}".encode()))


def request_changes(booking_id, customer_id, reason):
    reason = reason.strip()
    if not reason or len(reason) > 2000:
        raise ValueError("Обязательно укажите причину: до 2000 символов")
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.deleted_at or booking.customer_id != customer_id:
            raise ValueError("Заявка не найдена")
        request = latest_request(session, booking_id)
        if request and request.status == "pending" and booking.status == "confirmed":
            return summary(request)  # A repeated click must not create another request/event.
        if not can_request(booking, request):
            raise Conflict("Запрос доступен после отправки анкеты до начала подготовки подтверждённой заявки")
        row = CustomerChangeRequest(booking_id=booking_id, status="pending")
        _seal(row, {"reason": reason, "decision_comment": ""})
        session.add(row)
        session.add(Audit(booking_id=booking_id, actor_id=customer_id, action="customer_change_requested"))
        session.flush()
        return summary(row)


def view_request(booking_id, actor_id):
    with Session() as session:
        booking = session.get(Booking, booking_id)
        if not booking or booking.deleted_at or (booking.customer_id != actor_id and not staff_allows(actor_id, "operator")):
            raise ValueError("Заявка не найдена")
        row = latest_request(session, booking_id)
        return {**summary(row), **_open(row)} if row else None


def ensure_no_pending_request(session, booking):
    row = latest_request(session, booking.id)
    if row and row.status == "pending":
        raise Conflict("Сначала подтвердите или отклоните запрос клиента на изменения")


def obsolete_request(session, booking):
    row = latest_request(session, booking.id)
    if row and row.status == "pending":
        row.status, row.decided_at = "obsolete", now()


def decide_request(booking_id, request_id, actor_id, approve, comment=""):
    require_role(actor_id)
    comment = comment.strip()
    if len(comment) > 2000:
        raise ValueError("Комментарий должен быть не длиннее 2000 символов")
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.deleted_at:
            raise ValueError("Заявка не найдена")
        row = latest_request(session, booking_id)
        if not row or row.id != request_id:
            raise Conflict("Запрос устарел; обновите заявку")
        desired = "approved" if approve else "rejected"
        if row.status == desired:
            return summary(row)
        if row.status != "pending" or booking.status != "confirmed":
            raise Conflict("Запрос уже обработан или этап заявки изменился")
        from .rental import _claim_stage, _ensure_assignee
        _claim_stage(session, booking, actor_id)
        _ensure_assignee(session, booking, actor_id)
        payload = _open(row)
        if not row.ciphertext:
            raise Conflict("Причина запроса удалена; клиент должен отправить новый запрос")
        payload["decision_comment"] = comment
        _seal(row, payload)
        row.status, row.reviewer_id, row.decided_at = desired, actor_id, now()
        if approve:
            from .booking_changes import _snapshot
            before = _snapshot(booking)
            change = BookingChange(booking_id=booking_id, actor_id=actor_id, change_type="client_fix", status="pending")
            change.nonce = os.urandom(12)
            change.ciphertext = AESGCM(_master_key()).encrypt(change.nonce, json.dumps({"before": before, "after": before,
                "comment": "Запрос на изменения одобрен. Исправьте даты или состав заявки и отправьте её на повторное подтверждение."}, ensure_ascii=False).encode(),
                f"booking-change:{booking_id}".encode())
            session.add(change)
            session.flush()
            row.change_id = change.id
            booking.status, booking.hold_expires_at = "needs_changes", None
        session.execute(delete(BookingOperationLease).where(BookingOperationLease.booking_id == booking_id,
                                                           BookingOperationLease.stage == "confirmed"))
        session.add(Audit(booking_id=booking_id, actor_id=actor_id, action=f"customer_change_{desired}"))
        return summary(row)
