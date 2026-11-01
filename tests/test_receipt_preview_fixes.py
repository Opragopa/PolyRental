import hashlib
import os
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from app.db import Booking, BookingDocument, ReceiptArchive, Session
from app.miniapp_server import app
from app.pii import _master_key
from app.receipt_archive import ReceiptExpired, customer_receipt_pdf, now, purge_expired_receipts
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def test_historical_docx_can_be_read_without_regeneration_and_keeps_original_expiry(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    body = b"synthetic historical receipt bytes"
    nonce = os.urandom(12)
    created = now() - timedelta(days=100)
    with Session.begin() as session:
        session.get(Booking, booking_id).status = "returned"
        session.add(BookingDocument(booking_id=booking_id, kind="receipt", filename="legacy.docx",
            nonce=nonce, encrypted_data=AESGCM(_master_key()).encrypt(nonce, body, f"{booking_id}:receipt:doc-v1".encode()),
            sha256=hashlib.sha256(body).hexdigest(), created_at=created))
    with pytest.raises(ValueError):
        customer_receipt_pdf(booking_id, 43)
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    with TestClient(app) as client:
        response = client.get("/api/miniapp/profile/history?category=completed",
                              headers={"X-Telegram-Init-Data": signed_init_data(42)})
        assert response.status_code == 200
        assert next(item for item in response.json()["items"] if item["id"] == booking_id)["receipt_available"]
    assert customer_receipt_pdf(booking_id, 42) == (body, "legacy.docx")
    with Session() as session:
        archive = session.get(ReceiptArchive, booking_id)
        assert archive.created_at == created
        expiry = archive.expires_at
        assert session.get(BookingDocument, (booking_id, "receipt_docx")) is None
    assert purge_expired_receipts(expiry) == 1
    with pytest.raises(ReceiptExpired):
        customer_receipt_pdf(booking_id, 42)


def test_staff_download_ticket_uses_saved_docx_filename_and_type(monkeypatch):
    from tests.test_completion_workflows import ready_booking
    from app.rental import transition
    booking_id = ready_booking(monkeypatch)
    transition(booking_id, "ready", 100)
    monkeypatch.setenv("PUBLIC_URL", "https://polyrental.test")
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    with TestClient(app) as client:
        headers = {"X-Telegram-Init-Data": signed_init_data(200)}
        ticket = client.post(f"/api/miniapp/admin/bookings/{booking_id}/documents/receipt/download-link", headers=headers)
        assert ticket.status_code == 200
        assert ticket.json()["file_name"].endswith(".docx")
        document = client.get(ticket.json()["url"])
        assert document.status_code == 200
        assert "wordprocessingml.document" in document.headers["content-type"]
        assert ticket.json()["file_name"] in document.headers["content-disposition"]
        assert client.get(ticket.json()["url"]).status_code == 404
