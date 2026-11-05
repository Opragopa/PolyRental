"""Request-scoped history, stage visibility, and v0.3.0 security boundaries."""

import json
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Audit, Booking, BookingOperationLease, CustomerIdentity, PIIAudit, Session
from app.miniapp_server import app
from app.rental import active_operation_leases, claim_booking_operation, get_booking, now, transition
from tests.test_miniapp import configure, create_confirmed, image_bytes, signed_init_data
from tests.test_operation_lease import pending_booking


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def submit_form(client, booking_id):
    customer = headers(42)
    consent = client.get("/api/miniapp/privacy-consent", headers=customer).json()
    fields = dict(full_name="Анна Иванова", birth_date="2000-01-01", passport_series="4510",
                  passport_number="123456", passport_issued_at="2020-01-01", passport_issuer="ОВД",
                  passport_division_code="770-001", registration_address="Москва",
                  residential_address="Москва", student_id_number="12345678",
                  student_institution="Санкт-Петербургский государственный университет")
    files = {kind: ("synthetic.png", image_bytes(), "image/png")
             for kind in ("passport_main", "passport_registration", "student_front")}
    response = client.post(f"/api/miniapp/bookings/{booking_id}/identity", headers=customer,
                           data={"payload": json.dumps(fields), "policy_version": consent["version"],
                                 "text_hash": consent["text_hash"]}, files=files)
    assert response.status_code == 200, response.text


def test_history_is_staff_only_ordered_and_content_free(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    transition(booking_id, "confirmed", 100)
    stamp = now() + timedelta(seconds=1)
    with Session.begin() as session:
        for action in ("submitted", "verified", "changes_requested"):
            session.add(PIIAudit(booking_id=booking_id, actor_id=200, action=action, created_at=stamp))
        # Reads and unknown legacy actions are never exposed to staff.
        for action in ("view_masked", "revealed", "document_downloaded", "sensitive-unknown"):
            session.add(PIIAudit(booking_id=booking_id, actor_id=200, action=action))
        session.add(Audit(booking_id=booking_id, actor_id=100, action="sensitive-unknown"))
    url = f"/api/miniapp/admin/bookings/{booking_id}/history"
    with TestClient(app) as client:
        assert client.get(url).status_code == 401
        assert client.get(url, headers=headers(42)).status_code == 403
        for staff in (100, 200):
            response = client.get(url, headers=headers(staff))
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            items = response.json()["items"]
            assert [item["action"] for item in items] == ["created", "assignee:100", "confirmed", "submitted", "verified", "changes_requested"]
            assert [item["actor_id"] for item in items] == [42, 100, 100, 200, 200, 200]
            assert [item["category"] for item in items] == ["status", "operation", "status", "identity", "identity", "identity"]
            assert len({item["id"] for item in items}) == len(items)
            for item in items:
                expected = {"id", "action", "actor_id", "actor_name", "created_at", "category"}
                if item["action"].startswith("assignee:"):
                    expected.add("target_name")
                assert set(item) == expected
                assert item["actor_name"]
            assert [item["created_at"] for item in items] == sorted(item["created_at"] for item in items)
            assert client.get(url, headers=headers(staff)).json() == response.json()
            assert "@client" not in response.text  # Contact details are not display-name fallbacks.
        assert client.get("/api/miniapp/admin/bookings/999999999/history", headers=headers(100)).status_code == 404


def test_expired_claim_visible_without_changing_active_lease_contract(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    claim_booking_operation(booking_id, 100, "Анна")
    with TestClient(app) as client:
        def item():
            response = client.get("/api/miniapp/admin/bookings", headers=headers(200))
            assert response.status_code == 200
            return next(row for row in response.json()["items"] if row["id"] == booking_id)
        active = item()
        assert active["operation_lease_state"] == {**active["operation_lease"], "expired": False}
        assert set(active["operation_lease"]) == {"stage", "actor_id", "actor_name", "expires_at"}
        with Session.begin() as session:
            session.get(BookingOperationLease, (booking_id, "pending")).expires_at = now() - timedelta(seconds=1)
        expired = item()
        assert expired["operation_lease"] is None
        assert expired["operation_lease_state"]["expired"] is True
        assert expired["operation_lease_state"]["actor_name"] == "Анна"
        assert booking_id not in active_operation_leases()
        response = client.post(f"/api/miniapp/admin/bookings/{booking_id}/transition", headers=headers(100),
                               json={"action": "confirmed"})
        assert response.status_code == 200
        assert item()["operation_lease_state"] is None


def test_invalid_actions_and_competing_operator_never_create_history(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    claim_booking_operation(booking_id, 100, "Анна")
    url = f"/api/miniapp/admin/bookings/{booking_id}"
    with TestClient(app) as client:
        original = client.get(url + "/history", headers=headers(100)).json()
        for actor, action, code in ((42, "confirmed", 403), (200, "confirmed", 409),
                                    (100, "ready", 409), (100, "invented-state", 409)):
            response = client.post(url + "/transition", headers=headers(actor), json={"action": action})
            assert response.status_code == code
            current = client.get(url + "/history", headers=headers(100)).json()
            # Authenticated requests may refresh a public Telegram name, but
            # failed operations must not add or alter stored audit events.
            stored = lambda result: [{key: value for key, value in item.items() if key not in {"actor_name", "target_name"}} for item in result["items"]]
            assert stored(current) == stored(original)
            assert get_booking(booking_id).status == "pending"


def test_manual_correction_and_approval_persist_safe_history_without_claiming_stage(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("DOCUMENT_CHECK_MODE", "manual")
    with TestClient(app) as client:
        booking_id = create_confirmed(client, headers(42))
        submit_form(client, booking_id)
        claim_booking_operation(booking_id, 100, "Анна")
        url = f"/api/miniapp/admin/bookings/{booking_id}"
        # A normal operator cannot fetch verdicts, reveal PII, download images,
        # or save a manual decision even while holding the workflow stage.
        for actor in (42, 100):
            for suffix, method, body in (("/identity", "GET", None),
                                          ("/identity/reveal", "POST", None),
                                          ("/identity/documents/student_front", "GET", None),
                                          ("/identity/review", "POST", {"approved": True})):
                response = client.request(method, url + suffix, headers=headers(actor), json=body)
                assert response.status_code == 403
        correction = {"approved": False, "comment": "Замените фото, реквизиты 123456", "fields": ["student_front"]}
        response = client.post(url + "/identity/review", headers=headers(200), json=correction)
        assert response.json() == {"status": "needs_changes"}
        with Session() as session:
            identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
            assert identity.status == "needs_changes"
            assert json.loads(identity.review_fields) == ["student_front"]
            from app.pii import _review_comment
            assert _review_comment(identity) == correction["comment"]
            assert correction["comment"] not in identity.review_comment
        response = client.post(url + "/identity/review", headers=headers(200), json={"approved": True})
        assert response.json() == {"status": "verified"}
        assert get_booking(booking_id).identity_status == "verified"
        with Session() as session:
            assert session.get(BookingOperationLease, (booking_id, "confirmed")).actor_id == 100
            assert session.get(BookingOperationLease, (booking_id, "identity_review")) is None
        history = client.get(url + "/history", headers=headers(100))
        assert [row["action"] for row in history.json()["items"]] == [
            "created", "assignee:100", "confirmed", "submitted", "changes_requested", "verified"]
        for secret in ("Анна Иванова", "123456", "student_front", "Замените фото", "document_checks", "manual_review"):
            assert secret not in history.text
        # Terminal requests reject further review and do not append a review event.
        transition(booking_id, "cancelled", 100)
        before = client.get(url + "/history", headers=headers(100)).json()
        assert client.post(url + "/identity/review", headers=headers(200), json={"approved": True}).status_code == 409
        assert client.get(url + "/history", headers=headers(100)).json() == before
