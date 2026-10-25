import base64
import hashlib
import hmac
import io
import json
import time
from datetime import timedelta
from urllib.parse import urlencode
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image

from app.bot import main_keyboard, miniapp_url
from app.db import CustomerIdentity, IdentityDocument, PIIAudit, Session
from app.documents import render_document
from app.miniapp import verify_init_data
from app.miniapp_server import app
from app.pii import purge_expired_identities, reveal_identity, sanitize_image
from app.service import availability, now, save_equipment, transition
from app.rental import assign_booking_assets

TOKEN = "123:test-secret"


def signed_init_data(user_id=42, auth_date=None):
    data = {"auth_date": str(int(auth_date if auth_date is not None else time.time())),
            "query_id": "test-query",
            "user": json.dumps({"id": user_id, "first_name": "Анна"}, ensure_ascii=False, separators=(",", ":"))}
    check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    data["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(data)


def image_bytes(fmt="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(output, format=fmt)
    return output.getvalue()


def configure(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", TOKEN)
    monkeypatch.setenv("ADMIN_IDS", "100")
    monkeypatch.setenv("PII_ADMIN_IDS", "200")
    monkeypatch.setenv("PII_MASTER_KEY", base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("="))
    monkeypatch.setenv("OPERATOR_NAME", "Учебный рентал")
    monkeypatch.setenv("OPERATOR_ADDRESS", "Москва")
    monkeypatch.setenv("OPERATOR_CONTACT", "privacy@example.test")
    monkeypatch.setenv("PRIVACY_POLICY_VERSION", "test-v1")


def create_confirmed(client, headers):
    save_equipment("CAM-01", "Камера", "Кинокамера", "100", "available")
    start, end = now() + timedelta(hours=3), now() + timedelta(hours=5)
    article_id = availability(start, end)[0]["id"]
    payload = {"request_id": str(uuid4()), "start": start.isoformat(), "end": end.isoformat(),
               "lines": [{"article_id": article_id, "quantity": 1}], "name": "Анна",
               "contact": "@anna", "expected_total": "200.00"}
    result = client.post("/api/miniapp/bookings", json=payload, headers=headers)
    assert result.status_code == 201
    booking_id = result.json()["id"]
    transition(booking_id, "confirmed", 100)
    return booking_id


def test_signature_and_catalog_hides_serial(monkeypatch):
    configure(monkeypatch)
    assert verify_init_data(signed_init_data())["id"] == 42
    assert verify_init_data(signed_init_data(auth_date=time.time() - 90000)) is None
    headers = {"X-Telegram-Init-Data": signed_init_data()}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers)
        body = client.get("/api/miniapp/bookings", headers=headers).json()
        assert body["items"][0]["id"] == booking_id
        assert "serial" not in json.dumps(body)
        assert body["items"][0]["identity_status"] == "required"


def test_encrypted_identity_upload_role_boundary_and_review(monkeypatch):
    configure(monkeypatch)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    admin = {"X-Telegram-Init-Data": signed_init_data(100)}
    pii_admin = {"X-Telegram-Init-Data": signed_init_data(200)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                  "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                  "passport_division_code": "770-001", "registration_address": "Москва",
                  "residential_address": "Москва", "student_id_number": "S-123",
                  "student_institution": "Университет", "student_valid_until": "2027-06-30"}
        files = {kind: (f"{kind}.png", image_bytes(), "image/png") for kind in
                 ("passport_main", "passport_registration", "student_front", "student_back")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                               data={"payload": json.dumps(fields), "policy_version": consent["version"],
                                     "text_hash": consent["text_hash"]}, files=files)
        assert response.status_code == 200
        assert client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=admin).status_code == 403
        masked = client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=pii_admin)
        assert masked.status_code == 200 and masked.json()["passport"].endswith("56")
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/identity/review", headers=pii_admin,
                           json={"approved": True, "comment": ""}).status_code == 200
        assert reveal_identity(booking_id, 200)["passport_number"] == "123456"
        assign_booking_assets(booking_id, 100)
        assert render_document(booking_id, "receipt", True, 200)[:2] == b"PK"


def test_bad_mime_rejected(monkeypatch):
    configure(monkeypatch)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        names = ("full_name", "birth_date", "passport_series", "passport_number", "passport_issued_at",
                 "passport_issuer", "passport_division_code", "registration_address", "residential_address",
                 "student_id_number", "student_institution", "student_valid_until")
        files = {kind: (f"{kind}.txt", b"not an image", "text/plain") for kind in
                 ("passport_main", "passport_registration", "student_front", "student_back")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                               data={"payload": json.dumps({key: "x" for key in names}),
                                     "policy_version": consent["version"], "text_hash": consent["text_hash"]},
                               files=files)
        assert response.status_code == 422


def test_image_is_reencoded_without_metadata():
    source = io.BytesIO()
    image = Image.new("RGB", (32, 32), "white")
    exif = Image.Exif()
    exif[0x010E] = "private metadata"
    image.save(source, format="JPEG", exif=exif)
    normalized, media_type = sanitize_image(source.getvalue(), "image/jpeg")
    with Image.open(io.BytesIO(normalized)) as result:
        assert media_type == "image/jpeg"
        assert not result.getexif()


def test_retention_purge_keeps_only_audit(monkeypatch):
    configure(monkeypatch)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        names = ("full_name", "birth_date", "passport_series", "passport_number", "passport_issued_at",
                 "passport_issuer", "passport_division_code", "registration_address", "residential_address",
                 "student_id_number", "student_institution", "student_valid_until")
        files = {kind: (f"{kind}.png", image_bytes(), "image/png") for kind in
                 ("passport_main", "passport_registration", "student_front", "student_back")}
        assert client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                           data={"payload": json.dumps({key: "x" for key in names}),
                                 "policy_version": consent["version"], "text_hash": consent["text_hash"]},
                           files=files).status_code == 200
    with Session.begin() as session:
        identity = session.query(CustomerIdentity).filter_by(booking_id=booking_id).one()
        identity.delete_after = now() - timedelta(seconds=1)
    assert purge_expired_identities() == 1
    with Session() as session:
        assert session.query(CustomerIdentity).filter_by(booking_id=booking_id).count() == 0
        assert session.query(IdentityDocument).count() == 0
        assert session.query(PIIAudit).filter_by(
            booking_id=booking_id, action="retention_purge").count() == 1


def test_bot_entry_uses_https_only(monkeypatch):
    monkeypatch.setenv("PUBLIC_URL", "http://localhost:8000")
    assert miniapp_url() is None and main_keyboard().keyboard[0][0].web_app is None
    monkeypatch.setenv("PUBLIC_URL", "https://rental.example")
    assert miniapp_url() == "https://rental.example/miniapp"
