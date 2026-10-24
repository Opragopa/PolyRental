from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
import hmac
import os
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db import Audit, Booking, BookingItem, Equipment, Occupancy, Session, init_db
from app.documents import render_document
from app.service import Conflict, availability, create_booking, now, save_equipment, transition
from app.web import app, verify_telegram


@pytest.fixture(autouse=True)
def clean_database():
    assert os.getenv("DATABASE_URL", "").split("/")[-1] == "polyrental_test", "Тесты разрешены только на отдельной БД polyrental_test"
    init_db()
    with Session.begin() as session:
        for model in (Audit, Occupancy, BookingItem, Booking, Equipment):
            session.execute(delete(model))
    yield


def test_booking_lifecycle_and_boundaries():
    item = save_equipment("CAM-01", "Камера", "", "100", "available")
    start = now() + timedelta(hours=2)
    end = start + timedelta(hours=2)
    booking = create_booking(7, "Анна", "+70000000000", start, end, [item])
    assert availability(start, end)[0]["available"] is False
    assert availability(end, end + timedelta(hours=1))[0]["available"] is True
    with pytest.raises(Conflict):
        create_booking(8, "Борис", "+70000000001", start, end, [item])
    assert transition(booking, "confirmed", 1) == "confirmed"
    assert transition(booking, "issued", 1) == "issued"
    assert transition(booking, "returned", 1) == "returned"
    assert availability(start, end)[0]["available"] is True


def test_atomic_multi_item_and_concurrent_requests():
    a = save_equipment("CAM-A", "Камера", "", "100", "available")
    b = save_equipment("CAM-B", "Камера", "", "100", "available")
    start = now() + timedelta(hours=3)
    end = start + timedelta(hours=2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create_booking, n, f"Клиент {n}", "телефон", start, end, [a, b]) for n in (1, 2)]
        outcomes = []
        for future in futures:
            try:
                outcomes.append(future.result())
            except Conflict:
                outcomes.append("conflict")
    assert len([v for v in outcomes if isinstance(v, int)]) == 1
    assert outcomes.count("conflict") == 1
    assert all(not row["available"] for row in availability(start, end))


def test_expiry_documents_and_feed(monkeypatch):
    item = save_equipment("LENS-01", "Объектив", "", "75", "available")
    start = now() + timedelta(hours=4)
    end = start + timedelta(hours=2)
    booking = create_booking(7, "Анна", "+70000000000", start, end, [item])
    with Session.begin() as session:
        record = session.get(Booking, booking)
        record.hold_expires_at = now() - timedelta(minutes=1)
    assert transition(booking, "confirmed", 1) == "expired"
    assert availability(start, end)[0]["available"] is True
    second = create_booking(7, "Анна", "+70000000000", start, end, [item])
    assert transition(second, "confirmed", 1) == "confirmed"
    assert render_document(second, "contract")[:2] == b"PK"
    assert render_document(second, "issue")[:2] == b"PK"
    assert render_document(second, "return")[:2] == b"PK"
    monkeypatch.setenv("ICAL_TOKEN", "test-calendar-token")
    with TestClient(app) as client:
        assert client.get("/calendar/bad.ics").status_code == 404
        response = client.get("/calendar/test-calendar-token.ics")
        assert response.status_code == 200
        assert f"booking-{second}" in response.text
        assert client.get("/admin").status_code == 403


def test_telegram_login_signature(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123:test-secret")
    data = {"id": "42", "auth_date": str(int(time.time())), "first_name": "Test"}
    check = "\n".join(f"{key}={data[key]}" for key in sorted(data))
    data["hash"] = hmac.new(hashlib.sha256(b"123:test-secret").digest(), check.encode(), hashlib.sha256).hexdigest()
    assert verify_telegram(data)
    assert not verify_telegram({**data, "id": "43"})
    assert not verify_telegram({**data, "auth_date": "invalid"})
