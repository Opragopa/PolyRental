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
from sqlalchemy import select
import pytest

from app.bot import main_keyboard, miniapp_url
from app.db import Booking, CustomerIdentity, IdentityDocument, PIIAudit, Session
from app.documents import render_document
from app.miniapp import verify_init_data
from app.miniapp_server import app
from app.pii import purge_expired_identities, reveal_identity, sanitize_image, submit_identity, validate_identity_payload
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
    monkeypatch.setenv("ADMIN_IDS", "100,200")
    monkeypatch.setenv("PII_ADMIN_IDS", "200")
    monkeypatch.setenv("PII_MASTER_KEY", base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("="))
    monkeypatch.setenv("OPERATOR_NAME", "Учебный рентал")
    monkeypatch.setenv("OPERATOR_ADDRESS", "Москва")
    monkeypatch.setenv("OPERATOR_CONTACT", "privacy@example.test")
    monkeypatch.setenv("PRIVACY_POLICY_VERSION", "test-v1")


def create_confirmed(client, headers):
    save_equipment("CAM-01", "Камера", "Кинокамера", "100", "available")
    start = now() + timedelta(days=4, hours=3)
    end = start + timedelta(hours=2)
    article_id = availability(start, end)[0]["id"]
    payload = {"request_id": str(uuid4()), "start": start.isoformat(), "end": end.isoformat(),
               "lines": [{"article_id": article_id, "quantity": 1}], "name": "Анна",
               "contact": "@anna1", "expected_total": "200.00"}
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


def test_identity_submission_explains_that_manager_confirmation_is_required(monkeypatch):
    configure(monkeypatch)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers)
    with Session.begin() as session:
        session.get(Booking, booking_id).status = "pending"
    with pytest.raises(ValueError, match="после подтверждения заявки менеджером"):
        submit_identity(booking_id, 42, {}, {})


@pytest.mark.parametrize("contact", ["+7 999 123-45-67", "89991234567", "@anna_123", "Alice123"])
def test_booking_contact_accepts_phone_or_telegram_username(contact):
    from app.miniapp import BookingRequest
    payload = {"request_id": str(uuid4()), "start": now() + timedelta(hours=3),
               "end": now() + timedelta(hours=5), "lines": [{"article_id": 1, "quantity": 1}],
               "name": "Анна", "contact": contact, "expected_total": "200.00"}
    assert BookingRequest.model_validate(payload).contact == contact


@pytest.mark.parametrize("contact", ["", "12345", "8999123456x", "@abc", "Иван Иванов", "+ +79991234567"])
def test_booking_contact_rejects_invalid_values(contact):
    from app.miniapp import BookingRequest
    from pydantic import ValidationError
    payload = {"request_id": str(uuid4()), "start": now() + timedelta(hours=3),
               "end": now() + timedelta(hours=5), "lines": [{"article_id": 1, "quantity": 1}],
               "name": "Анна", "contact": contact or " ", "expected_total": "200.00"}
    with pytest.raises(ValidationError):
        BookingRequest.model_validate(payload)


def test_encrypted_identity_upload_role_boundary_and_review(monkeypatch):
    import app.miniapp as miniapp_api
    configure(monkeypatch)
    notified = []
    async def capture_notification(booking_id):
        notified.append(booking_id)
    monkeypatch.setattr(miniapp_api, "notify_identity_submitted", capture_notification)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    admin = {"X-Telegram-Init-Data": signed_init_data(100)}
    pii_admin = {"X-Telegram-Init-Data": signed_init_data(200)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                  "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                  "passport_division_code": "770-001", "registration_address": "Москва",
                  "residential_address": "Москва", "student_id_number": "12345678",
                  "student_institution": "Санкт-Петербургский государственный университет"}
        files = {kind: (f"{kind}.png", image_bytes(), "image/png") for kind in
                     ("passport_main", "passport_registration", "student_front")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                               data={"payload": json.dumps(fields), "policy_version": consent["version"],
                                     "text_hash": consent["text_hash"]}, files=files)
        assert response.status_code == 200
        assert notified == [booking_id]
        public_profile = client.get("/api/miniapp/profile", headers=customer)
        assert "passport_number" not in public_profile.text
        assert client.get("/api/miniapp/profile/identity").status_code == 401
        other = client.get("/api/miniapp/profile/identity", headers={"X-Telegram-Init-Data": signed_init_data(43)})
        assert other.json() == {"fields": {}}
        revealed = client.get("/api/miniapp/profile/identity", headers=customer)
        assert revealed.headers["cache-control"] == "no-store"
        assert revealed.json()["fields"]["passport_number"] == "123456"
        with Session() as session:
            assert session.scalar(select(PIIAudit.id).where(PIIAudit.booking_id == booking_id,
                PIIAudit.actor_id == 42, PIIAudit.action == "profile_identity_revealed"))
        customer_orders = client.get("/api/miniapp/bookings", headers=customer).json()["items"]
        assert next(order for order in customer_orders if order["id"] == booking_id)["identity_status"] == "submitted"
        assert client.get(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer).json()["status"] == "submitted"
        assert client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=admin).status_code == 403
        masked = client.get(f"/api/miniapp/admin/bookings/{booking_id}/identity", headers=pii_admin)
        assert masked.status_code == 200 and masked.json()["passport"].endswith("56")
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/identity/review", headers=pii_admin,
                           json={"approved": True, "comment": ""}).status_code == 200
        assert reveal_identity(booking_id, 200)["passport_number"] == "123456"
        assign_booking_assets(booking_id, 100)
        receipt = render_document(booking_id, "receipt", True, 200)
        assert receipt[:2] == b"PK"
        from docx import Document
        from app.rental import get_booking
        document = Document(io.BytesIO(receipt))
        receipt_text = "\n".join([p.text for p in document.paragraphs] + [cell.text for table in document.tables for row in table.rows for cell in row.cells])
        assert get_booking(booking_id).human_number in receipt_text


def test_bad_mime_rejected(monkeypatch):
    configure(monkeypatch)
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, customer)
        consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
        names = ("full_name", "birth_date", "passport_series", "passport_number", "passport_issued_at",
                 "passport_issuer", "passport_division_code", "registration_address", "residential_address",
                 "student_id_number", "student_institution")
        files = {kind: (f"{kind}.txt", b"not an image", "text/plain") for kind in
                 ("passport_main", "passport_registration", "student_front")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                               data={"payload": json.dumps({key: "x" for key in names}),
                                     "policy_version": consent["version"], "text_hash": consent["text_hash"]},
                               files=files)
        assert response.status_code == 422


def test_identity_sensitive_fields_are_validated():
    valid = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
             "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
             "passport_division_code": "770-001", "registration_address": "Москва",
             "residential_address": "Москва", "student_id_number": "12345678",
             "student_institution": "Санкт-Петербургский государственный университет"}
    assert validate_identity_payload(valid)["passport_series"] == "4510"
    for key, value in (("passport_series", "45"), ("passport_number", "123"),
                       ("passport_division_code", "770001"), ("birth_date", "2099-01-01")):
        invalid = {**valid, key: value}
        with pytest.raises(ValueError):
            validate_identity_payload(invalid)
    for student_id in ("", "1234567", "1234abcd"):
        assert validate_identity_payload({**valid, "student_id_number": student_id})["student_id_number"] == student_id
    for student_id in ("123456789", "1234 5678"):
        with pytest.raises(ValueError, match="не более 8 символов"):
            validate_identity_payload({**valid, "student_id_number": student_id})
    legacy = {**valid, "student_institution": "Мой старый вуз"}
    assert validate_identity_payload(legacy)["student_institution"] == "Мой старый вуз"
    assert validate_identity_payload(legacy, legacy_institution="Мой старый вуз")["student_institution"] == "Мой старый вуз"


def test_identity_submit_returns_student_field_error(monkeypatch):
    configure(monkeypatch)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers)
        fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                  "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                  "passport_division_code": "770-001", "registration_address": "Санкт-Петербург",
                  "residential_address": "Санкт-Петербург", "student_id_number": "123456789",
                  "student_institution": "Санкт-Петербургский государственный университет"}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers,
                               data={"payload": json.dumps(fields), "policy_version": "test-v1", "text_hash": "test-hash"})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], dict), response.text
    assert response.json()["detail"]["field"] == "student_id_number"


def test_identity_age_and_passport_date_boundaries(monkeypatch):
    from datetime import datetime, timezone
    from app import pii
    monkeypatch.setattr(pii, "now", lambda: datetime(2026, 10, 28, 12, tzinfo=timezone.utc))
    valid = {"full_name": "Анна Иванова", "birth_date": "2010-10-28", "passport_series": "4510",
             "passport_number": "123456", "passport_issued_at": "2024-10-28", "passport_issuer": "ОВД",
             "passport_division_code": "770-001", "registration_address": "Москва",
             "residential_address": "Москва"}
    assert validate_identity_payload(valid)["student_id_number"] == ""
    with pytest.raises(ValueError, match="16 лет"):
        validate_identity_payload({**valid, "birth_date": "2010-10-29"})
    with pytest.raises(ValueError, match="Дата выдачи паспорта"):
        validate_identity_payload({**valid, "passport_issued_at": "2024-10-27"})


def test_identity_submit_returns_bad_photo_field(monkeypatch):
    configure(monkeypatch)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers)
        fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                  "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                  "passport_division_code": "770-001", "registration_address": "Санкт-Петербург",
                  "residential_address": "Санкт-Петербург", "student_id_number": "12345678",
                  "student_institution": "Санкт-Петербургский государственный университет"}
        files = {"passport_main": ("passport.png", b"not an image", "image/png"),
                 "passport_registration": ("registration.png", image_bytes(), "image/png"),
                 "student_front": ("student.png", image_bytes(), "image/png")}
        response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers,
                               data={"payload": json.dumps(fields), "policy_version": "test-v1", "text_hash": "test-hash"}, files=files)
    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "passport_main", response.text


def test_name_correction_omits_consent_fields_and_keeps_uploaded_photos(monkeypatch):
    import app.miniapp as miniapp_api
    from app.pii import review_identity
    configure(monkeypatch)
    notified = []
    async def capture_notification(booking_id):
        notified.append(booking_id)
    monkeypatch.setattr(miniapp_api, "notify_identity_submitted", capture_notification)
    headers = {"X-Telegram-Init-Data": signed_init_data(42)}
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers)
        consent = client.get("/api/miniapp/privacy-consent", headers=headers).json()
        fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                  "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                  "passport_division_code": "770-001", "registration_address": "Санкт-Петербург",
                  "residential_address": "Санкт-Петербург", "student_id_number": "12345678",
                  "student_institution": "Санкт-Петербургский государственный университет"}
        files = {kind: (f"{kind}.png", image_bytes(), "image/png") for kind in
                 ("passport_main", "passport_registration", "student_front")}
        first = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers,
                            data={"payload": json.dumps(fields), "policy_version": consent["version"],
                                  "text_hash": consent["text_hash"]}, files=files)
        assert first.status_code == 200
        review_identity(booking_id, 200, False, "Исправьте ФИО", ["full_name"])
        before = client.get(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers).json()
        assert set(before["documents"]) == set(files)
        corrected = {**fields, "full_name": "Анна Петрова"}
        second = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers,
                             data={"payload": json.dumps(corrected)})
        assert second.status_code == 200, second.text
        after = client.get(f"/api/miniapp/bookings/{booking_id}/identity", headers=headers).json()
        orders = client.get("/api/miniapp/bookings", headers=headers).json()["items"]
        assert next(order for order in orders if order["id"] == booking_id)["identity_status"] == "submitted"
        assert notified == [booking_id, booking_id]
    assert after["fields"]["full_name"] == "Анна Петрова"
    assert set(after["documents"]) == set(files)


def test_address_suggestions_requires_auth_and_falls_back_without_token(monkeypatch):
    configure(monkeypatch)
    monkeypatch.delenv("DADATA_API_KEY", raising=False)
    with TestClient(app) as client:
        assert client.post("/api/miniapp/address-suggestions", json={"query": "СПб Невский"}).status_code == 401
        response = client.post("/api/miniapp/address-suggestions",
                               headers={"X-Telegram-Init-Data": signed_init_data(42)},
                               json={"query": "СПб Невский"})
    assert response.status_code == 503
    assert "вручную" in response.json()["detail"]


def test_address_suggestions_proxy_returns_only_public_suggestion_values(monkeypatch):
    import app.miniapp as miniapp_api
    configure(monkeypatch)
    monkeypatch.setenv("DADATA_API_KEY", "test-key-never-sent-to-browser")
    calls = []
    async def fake_suggest(query, token):
        calls.append((query, token))
        return [{"value": "г Санкт-Петербург, Невский пр-кт", "address": "191025, г Санкт-Петербург, Невский пр-кт"}]
    monkeypatch.setattr(miniapp_api, "_dadata_address_suggestions", fake_suggest)
    with TestClient(app) as client:
        response = client.post("/api/miniapp/address-suggestions",
                               headers={"X-Telegram-Init-Data": signed_init_data(42)},
                               json={"query": "СПб Невский"})
    assert response.status_code == 200
    assert response.json()["items"][0]["address"].startswith("191025,")
    assert calls == [("СПб Невский", "test-key-never-sent-to-browser")]


def test_address_suggestions_provider_failure_keeps_manual_entry_available(monkeypatch):
    import httpx
    import app.miniapp as miniapp_api
    configure(monkeypatch)
    monkeypatch.setenv("DADATA_API_KEY", "test-secret")
    async def fail_suggest(query, token):
        raise httpx.ReadTimeout("provider details must not reach the user")
    monkeypatch.setattr(miniapp_api, "_dadata_address_suggestions", fail_suggest)
    with TestClient(app) as client:
        response = client.post("/api/miniapp/address-suggestions",
                               headers={"X-Telegram-Init-Data": signed_init_data(42)},
                               json={"query": "СПб Невский"})
    assert response.status_code == 503
    assert "вручную" in response.json()["detail"]
    assert "provider details" not in response.text


def test_university_catalog_requires_auth_and_contains_spb_universities(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/miniapp/universities").status_code == 401
        response = client.get("/api/miniapp/universities",
                              headers={"X-Telegram-Init-Data": signed_init_data(42)})
    assert response.status_code == 200
    assert "Санкт-Петербургский государственный университет" in response.json()["items"]


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
        files = {kind: (f"{kind}.png", image_bytes(), "image/png") for kind in
                 ("passport_main", "passport_registration", "student_front")}
        identity_fields = {"full_name": "Анна Иванова", "birth_date": "2000-01-01", "passport_series": "4510",
                           "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                           "passport_division_code": "770-001", "registration_address": "Москва",
                           "residential_address": "Москва", "student_id_number": "12345678",
                           "student_institution": "Санкт-Петербургский государственный университет"}
        assert client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                           data={"payload": json.dumps(identity_fields),
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
