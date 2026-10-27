from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app import receipt_archive
from app.db import Booking, BookingDocument, PIIAudit, ReceiptArchive, Session
from app.receipt_archive import ReceiptExpired, archived_receipt_pdf, purge_expired_receipts
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking


def test_pdf_archive_is_encrypted_idempotent_and_expires(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    clock = [datetime(2024, 2, 29, 12, tzinfo=timezone.utc)]
    monkeypatch.setattr(receipt_archive, "now", lambda: clock[0])
    calls = []
    monkeypatch.setattr(receipt_archive, "render_receipt_pdf", lambda *_: calls.append(1) or b"%PDF-synthetic")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: archived_receipt_pdf(booking_id, 100), range(2)))
    assert results[0] == results[1]
    assert results[0][0] == b"%PDF-synthetic"
    assert len(calls) == 1
    with Session() as session:
        lifecycle = session.get(ReceiptArchive, booking_id)
        doc = session.get(BookingDocument, (booking_id, "receipt_pdf"))
        assert lifecycle.expires_at == datetime(2029, 2, 28, 12, tzinfo=timezone.utc)
        assert doc.encrypted_data != results[0][0] and doc.media_type == "application/pdf"
    clock[0] = datetime(2029, 2, 28, 12, tzinfo=timezone.utc) - timedelta(microseconds=1)
    assert archived_receipt_pdf(booking_id, 42)[0] == results[0][0]
    clock[0] += timedelta(microseconds=1)
    assert purge_expired_receipts(clock[0]) == 1
    assert purge_expired_receipts(clock[0]) == 0
    with pytest.raises(ReceiptExpired):
        archived_receipt_pdf(booking_id, 42)
    assert len(calls) == 1
    with Session() as session:
        assert session.get(BookingDocument, (booking_id, "receipt_pdf")) is None
        assert session.get(ReceiptArchive, booking_id).expired_at == clock[0]
        assert session.scalar(select(PIIAudit.id).where(PIIAudit.booking_id == booking_id,
                                                        PIIAudit.action == "receipt_retention_purge"))


def test_expired_access_removes_pdf_without_regeneration(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    clock = [datetime(2026, 10, 28, 12, tzinfo=timezone.utc)]
    monkeypatch.setattr(receipt_archive, "now", lambda: clock[0])
    calls = []
    monkeypatch.setattr(receipt_archive, "render_receipt_pdf", lambda *_: calls.append(1) or b"%PDF-synthetic")
    archived_receipt_pdf(booking_id, 100)
    clock[0] = datetime(2031, 10, 28, 12, tzinfo=timezone.utc)
    with pytest.raises(ReceiptExpired):
        archived_receipt_pdf(booking_id, 42)
    with Session() as session:
        assert session.get(BookingDocument, (booking_id, "receipt_pdf")) is None
        assert session.get(ReceiptArchive, booking_id).expired_at == clock[0]
    assert calls == [1]


def test_customer_can_download_only_own_existing_pdf_and_one_use_link(monkeypatch):
    from fastapi.testclient import TestClient
    from urllib.parse import urlsplit
    from app.miniapp_server import app
    from tests.test_miniapp import signed_init_data

    configure(monkeypatch)
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    booking_id = pending_booking()
    calls = []
    monkeypatch.setattr(receipt_archive, "render_receipt_pdf", lambda *_: calls.append(1) or b"%PDF-synthetic")
    def headers(user_id):
        return {"X-Telegram-Init-Data": signed_init_data(user_id)}
    url = f"/api/miniapp/bookings/{booking_id}/receipt"
    with TestClient(app) as client:
        assert client.get(url).status_code == 401
        assert client.get(url, headers=headers(42)).status_code == 404
        assert calls == []  # Reading cannot create a receipt.
        archived_receipt_pdf(booking_id, 100)
        assert client.get(url, headers=headers(43)).status_code == 404
        response = client.get(url, headers=headers(42))
        assert response.content == b"%PDF-synthetic"
        assert response.headers["content-type"] == "application/pdf"
        assert response.headers["cache-control"] == "no-store"
        history = client.get("/api/miniapp/profile/history", headers=headers(42)).json()["items"]
        assert next(item for item in history if item["id"] == booking_id)["receipt_available"]
        assert client.post(url + "/download-link", headers=headers(43)).status_code == 404
        ticket = client.post(url + "/download-link", headers=headers(42)).json()
        assert ticket["file_name"].endswith(".pdf")
        path = urlsplit(ticket["url"]).path
        assert client.get(path).content == b"%PDF-synthetic"
        assert client.get(path).status_code == 404
        ticket = client.post(url + "/download-link", headers=headers(42)).json()
        with Session.begin() as session:
            session.get(Booking, booking_id).customer_id = 43
        assert client.get(urlsplit(ticket["url"]).path).status_code == 404
        with Session.begin() as session:
            session.get(Booking, booking_id).customer_id = 42
        with Session.begin() as session:
            session.get(ReceiptArchive, booking_id).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert client.get(url, headers=headers(42)).status_code == 410
        assert client.get(url, headers=headers(43)).status_code == 404
        history = client.get("/api/miniapp/profile/history", headers=headers(42)).json()["items"]
        assert not next(item for item in history if item["id"] == booking_id)["receipt_available"]
        assert calls == [1]
