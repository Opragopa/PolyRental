"""Release boundaries: a signed Telegram ID, private verdicts, local fallback."""
import asyncio
import io
import json
import logging
import subprocess
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app import bot
from app.db import IdentityDocument, Session
from app.document_check import LocalDocumentChecker, Verdict, check_documents
from app.miniapp_server import app
from app.roles import configured_ids, role_for, validate_role_config
from app.rental import availability, create_booking, get_booking, now, save_equipment
from tests.test_miniapp import configure, create_confirmed, image_bytes, signed_init_data


@pytest.mark.parametrize("value", ["", " ", "100,nope", "100,", "0", "-1", "1.0", "9223372036854775808"])
def test_invalid_admin_config_fails_startup(monkeypatch, value):
    monkeypatch.setenv("ADMIN_IDS", value)
    with pytest.raises(RuntimeError, match="ADMIN_IDS"):
        validate_role_config()
    with pytest.raises(RuntimeError, match="ADMIN_IDS"):
        with TestClient(app):
            pass


def test_missing_and_invalid_pii_config(monkeypatch):
    monkeypatch.delenv("ADMIN_IDS", raising=False)
    with pytest.raises(RuntimeError, match="ADMIN_IDS"):
        validate_role_config()
    monkeypatch.setenv("ADMIN_IDS", "100, 100, 101")
    monkeypatch.delenv("PII_ADMIN_IDS", raising=False)
    assert configured_ids("ADMIN_IDS") == {100, 101}
    assert not role_for(100)["pii_admin"]
    monkeypatch.setenv("PII_ADMIN_IDS", "wrong")
    with pytest.raises(RuntimeError, match="PII_ADMIN_IDS"):
        validate_role_config()


def test_every_entry_uses_same_role_and_runtime_env(monkeypatch, caplog):
    configure(monkeypatch)
    from app.web import require_admin as web_admin
    from fastapi import HTTPException
    with TestClient(app) as client, caplog.at_level(logging.WARNING, logger="polyrental.access"):
        for user_id in (42, 100, 200):
            headers = {"X-Telegram-Init-Data": signed_init_data(user_id)}
            result = client.get("/api/miniapp/me", headers=headers)
            assert result.json() == role_for(user_id)
            assert bot.is_admin(user_id) == result.json()["admin"]
            if result.json()["admin"]:
                assert web_admin(SimpleNamespace(session={"admin_id": user_id})) == user_id
            else:
                with pytest.raises(HTTPException) as denied:
                    web_admin(SimpleNamespace(session={"admin_id": user_id}))
                assert denied.value.status_code == 403
        monkeypatch.setenv("ADMIN_IDS", "42")
        assert client.get("/api/miniapp/me", headers={"X-Telegram-Init-Data": signed_init_data(42)}).json()["admin"]
        assert not bot.is_admin(100)
        assert not role_for("42")["admin"]
        assert "id=200" in caplog.text and "entry=miniapp" in caplog.text
        assert "Анна" not in caplog.text and "auth_date" not in caplog.text


@pytest.mark.parametrize("user_id,staff", [(42, False), (100, True), (200, True)])
def test_bot_launches_authenticated_inline_app(monkeypatch, user_id, staff):
    configure(monkeypatch)
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    message = SimpleNamespace(from_user=SimpleNamespace(id=user_id), answer=AsyncMock())
    asyncio.run(bot.book(message, AsyncMock()))
    button = message.answer.call_args.kwargs["reply_markup"].inline_keyboard[0][0]
    assert button.web_app.url == "https://example.test/miniapp?startapp=booking"
    assert button.text == "Открыть каталог"
    assert bot.main_keyboard().keyboard[0][0].web_app is None


def test_customer_isolation_and_bot_api_sync(monkeypatch):
    configure(monkeypatch)
    save_equipment("SYNC", "Камера", "", 0, "available")
    start = now() + timedelta(days=5)
    article = availability(start, start + timedelta(hours=1))[0]["id"]
    first = create_booking(42, "Клиент", "@sync1", start, start + timedelta(hours=1), [{"article_id": article, "quantity": 1}])
    second_start = start + timedelta(days=3)
    second = create_booking(43, "Другой", "@sync2", second_start, second_start + timedelta(hours=1), [{"article_id": article, "quantity": 1}])
    with TestClient(app) as client:
        customer = {"X-Telegram-Init-Data": signed_init_data(42)}
        assert [row["id"] for row in client.get("/api/miniapp/bookings", headers=customer).json()["items"]] == [first]
        assert client.get("/api/miniapp/admin/bookings", headers=customer).status_code == 403
        assert client.get("/api/miniapp/me", headers={"X-Telegram-Init-Data": signed_init_data(42).replace("42", "100")}).status_code == 401
        for staff in (100, 200):
            rows = client.get("/api/miniapp/admin/bookings", headers={"X-Telegram-Init-Data": signed_init_data(staff)}).json()["items"]
            assert {row["id"] for row in rows} >= {first, second}
        message = SimpleNamespace(from_user=SimpleNamespace(id=42), answer=AsyncMock())
        asyncio.run(bot.my_bookings(message))
        assert get_booking(first).human_number in message.answer.call_args.args[0]
        assert get_booking(second).human_number not in message.answer.call_args.args[0]
        third_start = start + timedelta(days=6)
        payload = {"request_id": str(uuid4()), "start": third_start.isoformat(), "end": (third_start + timedelta(hours=1)).isoformat(),
                   "lines": [{"article_id": article, "quantity": 1}], "name": "Клиент", "contact": "@sync1"}
        created = client.post("/api/miniapp/bookings", headers=customer, json=payload)
        assert created.status_code == 201
        assert client.post("/api/miniapp/bookings", headers=customer, json=payload).json()["id"] == created.json()["id"]
        asyncio.run(bot.my_bookings(message))
        assert created.json()["human_number"] in message.answer.call_args.args[0]


def noisy_image():
    output = io.BytesIO()
    Image.effect_noise((128, 128), 50).convert("RGB").save(output, format="PNG")
    return output.getvalue()


@pytest.mark.parametrize("text,document,student", [
    ("СТУДЕНЧЕСКИЙ БИЛЕТ", "document", "student"), ("Student ID", "document", "student"),
    ("ПАСПОРТ РОССИЙСКОЙ ФЕДЕРАЦИИ", "document", "other"), ("блики", "unknown", "unknown"),
])
def test_local_classification_never_exposes_ocr(monkeypatch, text, document, student):
    import app.document_check as checks
    monkeypatch.setattr(checks.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout=text.encode()))
    result = check_documents({"student_front": (noisy_image(), "image/png")})["student_front"]
    assert result["document"] == document and result["student"] == student
    assert result["manual_review"] and text not in json.dumps(result)


def test_blank_non_document_and_provider_fallback(monkeypatch, caplog):
    assert LocalDocumentChecker().check(image_bytes()).document == "not_document"
    class Broken:
        def check(self, data):
            raise RuntimeError("private image text must never be logged")
    result = check_documents({"student_front": (b"unused", "image/jpeg")}, Broken())
    assert result["student_front"]["reason"] == "unavailable"
    assert "private image" not in caplog.text
    import app.document_check as checks
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("tesseract", .65)
    monkeypatch.setattr(checks.subprocess, "run", timeout)
    assert LocalDocumentChecker().check(noisy_image()).reason == "timeout"
    monkeypatch.setenv("DOCUMENT_CHECK_MODE", "manual")
    assert check_documents({"student_front": (b"unused", "image/jpeg")})["student_front"]["manual_review"]


def test_internal_checker_deadline():
    import time
    from threading import Event
    gate = Event()
    class Slow:
        def check(self, data):
            gate.wait(3)
            return Verdict()
    try:
        before = time.monotonic()
        result = check_documents({"student_front": (b"x", "image/jpeg")}, Slow())
        assert time.monotonic() - before < 3
        assert result["student_front"]["reason"] == "timeout"
    finally:
        gate.set()


@pytest.mark.parametrize("angle", [-12, -7, 0, 7, 12])
def test_local_ocr_on_synthetic_student_document(angle):
    import shutil
    from PIL import ImageDraw, ImageFont
    if not shutil.which("tesseract"):
        pytest.skip("Local OCR is installed in the Docker test image")
    image = Image.new("RGB", (1100, 250), "white")
    # Purely synthetic label, without any person's data.
    font = ImageFont.truetype("DejaVuSans.ttf", 52)
    ImageDraw.Draw(image).text((35, 65), "СТУДЕНЧЕСКИЙ БИЛЕТ", font=font, fill="black")
    image = image.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")
    raw = io.BytesIO()
    image.save(raw, format="PNG")
    verdict = LocalDocumentChecker().check(raw.getvalue())
    assert verdict.document == "document" and verdict.student == "student"


def test_encrypted_verdict_and_pii_boundary(monkeypatch):
    configure(monkeypatch)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        fields = dict(full_name="Анна Иванова", birth_date="2000-01-01", passport_series="4510", passport_number="123456",
                      passport_issued_at="2020-01-01", passport_issuer="ОВД", passport_division_code="770-001",
                      registration_address="Москва", residential_address="Москва", student_id_number="12345678",
                      student_institution="Санкт-Петербургский государственный университет")
        files = {kind: ("photo.png", image_bytes(), "image/png") for kind in ("passport_main", "passport_registration", "student_front")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                               data={"payload": json.dumps(fields), "policy_version": consent["version"], "text_hash": consent["text_hash"]}, files=files)
        assert response.json() == {"status": "submitted"}
        url = f"/api/miniapp/admin/bookings/{booking_id}/identity"
        for user_id in (42, 100):
            assert client.get(url, headers={"X-Telegram-Init-Data": signed_init_data(user_id)}).status_code == 403
        pii_headers = {"X-Telegram-Init-Data": signed_init_data(200)}
        verdicts = client.get(url, headers=pii_headers).json()["document_checks"]
        assert verdicts["student_front"]["document"] == "not_document"
        with Session() as session:
            record = session.scalars(select(IdentityDocument)).first()
            assert b"not_document" not in record.encrypted_check
            assert record.check_nonce and record.encrypted_data != image_bytes()
        # Human decision is authoritative even when the machine says non-document.
        assert client.post(url + "/review", headers=pii_headers, json={"approved": True}).status_code == 200
        # Rollback removes advisory verdicts only; ciphertext and manual review survive.
        import importlib.util
        from pathlib import Path
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        from app.db import engine
        spec = importlib.util.spec_from_file_location("document_check_migration",
            Path(__file__).parents[1] / "alembic/versions/20261026_07_document_checks.py")
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        with Session() as session:
            before = {row.id: row.encrypted_data for row in session.scalars(select(IdentityDocument))}
        with engine.begin() as connection:
            migration.op = Operations(MigrationContext.configure(connection))
            migration.downgrade()
            migration.upgrade()
        with Session() as session:
            assert before == {row.id: row.encrypted_data for row in session.scalars(select(IdentityDocument))}
        legacy = client.get(url, headers=pii_headers).json()["document_checks"]
        assert all(check["reason"] == "manual_review" for check in legacy.values())
