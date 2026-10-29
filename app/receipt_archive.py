"""Encrypted PDF receipt storage with a durable five-year expiry record.

Callers must authenticate and authorize the actor before calling these helpers.
"""
from datetime import datetime, timezone
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, text

from .db import Booking, BookingDocument, BookingHandover, PIIAudit, ReceiptArchive, Session
from .pii import _master_key
from .receipt_pdf import render_receipt_pdf


class ReceiptExpired(ValueError):
    pass


def now():
    return datetime.now(timezone.utc)


def _five_years_after(value):
    try:
        return value.replace(year=value.year + 5)
    except ValueError:  # 29 February in a non-leap target year.
        return value.replace(year=value.year + 5, day=28)


def _decrypt(document):
    aad = f"{document.booking_id}:receipt_pdf:doc-v1".encode()
    return AESGCM(_master_key()).decrypt(document.nonce, document.encrypted_data, aad)


def archived_receipt_pdf(booking_id, actor_id):
    """Create once or read an unexpired encrypted PDF; never recreate after expiry."""
    expired = False
    result = None
    with Session.begin() as session:
        session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                        {"key": f"receipt-pdf:{booking_id}"})
        booking = session.get(Booking, booking_id)
        if booking is None or booking.deleted_at is not None:
            raise ValueError("Заявка не найдена")
        lifecycle = session.get(ReceiptArchive, booking_id, with_for_update=True)
        document = session.get(BookingDocument, (booking_id, "receipt_pdf"), with_for_update=True)
        timestamp = now()
        if lifecycle is not None and (lifecycle.expired_at is not None or lifecycle.expires_at <= timestamp):
            handover = session.get(BookingHandover, booking_id)
            if handover:
                handover.encrypted_recipient = handover.recipient_nonce = None
            if document is not None:
                session.delete(document)
            if lifecycle.expired_at is None:
                lifecycle.expired_at = timestamp
                session.add(PIIAudit(booking_id=booking_id, actor_id=0, action="receipt_retention_purge"))
            expired = True
        elif lifecycle is not None:
            if document is None:
                raise ValueError("Сохранённая расписка недоступна")
            result = (_decrypt(document), document.filename)
            session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="document_downloaded"))
        else:
            if document is not None:
                raise ValueError("Метаданные расписки отсутствуют")
            body = render_receipt_pdf(booking_id, actor_id)
            nonce = os.urandom(12)
            aad = f"{booking_id}:receipt_pdf:doc-v1".encode()
            filename = f"receipt-{(booking.human_number or 'request').replace('ТС', 'TS')}.pdf"
            session.add(ReceiptArchive(booking_id=booking_id, created_at=timestamp,
                                       expires_at=_five_years_after(timestamp)))
            session.add(BookingDocument(booking_id=booking_id, kind="receipt_pdf", filename=filename,
                        media_type="application/pdf", encrypted_data=AESGCM(_master_key()).encrypt(nonce, body, aad),
                        nonce=nonce, sha256=hashlib.sha256(body).hexdigest()))
            session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="document_archived"))
            result = (body, filename)
    if expired:
        raise ReceiptExpired("Срок хранения расписки истёк")
    return result


def customer_receipt_pdf(booking_id, customer_id, actor_id=None):
    """Read an existing PDF for its owner; never create one from a read request."""
    expired = False
    result = None
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        if booking is None or booking.customer_id != customer_id:
            raise ValueError("Расписка не найдена")
        lifecycle = session.get(ReceiptArchive, booking_id, with_for_update=True)
        if lifecycle is None:
            draft=session.get(BookingDocument,(booking_id,"receipt_pdf"))
            handover=session.get(BookingHandover,booking_id)
            if booking.status=="ready" and booking.deleted_at is None and draft and handover and handover.data.get("snapshot"):
                session.add(PIIAudit(booking_id=booking_id,actor_id=actor_id if actor_id is not None else customer_id,action="document_previewed"))
                return _decrypt(draft),draft.filename
            raise ValueError("Расписка не найдена")
        document = session.get(BookingDocument, (booking_id, "receipt_pdf"), with_for_update=True)
        timestamp = now()
        if lifecycle.expired_at is not None or lifecycle.expires_at <= timestamp:
            handover = session.get(BookingHandover, booking_id)
            if handover:
                handover.encrypted_recipient = handover.recipient_nonce = None
            if document is not None:
                session.delete(document)
            if lifecycle.expired_at is None:
                lifecycle.expired_at = timestamp
                session.add(PIIAudit(booking_id=booking_id, actor_id=0, action="receipt_retention_purge"))
            expired = True
        elif document is None:
            raise ValueError("Расписка не найдена")
        else:
            result = (_decrypt(document), document.filename)
            session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id if actor_id is not None else customer_id, action="document_downloaded"))
    if expired:
        raise ReceiptExpired("Срок хранения расписки истёк")
    return result


def purge_expired_receipts(at=None):
    """Remove expired PDF bytes while keeping the lifecycle metadata."""
    timestamp = at or now()
    with Session.begin() as session:
        rows = session.scalars(select(ReceiptArchive).where(
            ReceiptArchive.expired_at.is_(None), ReceiptArchive.expires_at <= timestamp)
            .with_for_update(skip_locked=True)).all()
        for lifecycle in rows:
            document = session.get(BookingDocument, (lifecycle.booking_id, "receipt_pdf"), with_for_update=True)
            if document is not None:
                session.delete(document)
            handover = session.get(BookingHandover, lifecycle.booking_id)
            if handover:
                handover.encrypted_recipient = handover.recipient_nonce = None
            lifecycle.expired_at = timestamp
            session.add(PIIAudit(booking_id=lifecycle.booking_id, actor_id=0, action="receipt_retention_purge"))
        return len(rows)
