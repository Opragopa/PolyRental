from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.db import BookingOperationLease, Session
from app.miniapp_server import app
from app.rental import (Conflict, claim_booking_operation, create_booking,
                        now, release_booking_operation, transition)
from app.service import Conflict as LegacyConflict, transition as legacy_transition
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def pending_booking():
    article_id = article_with_assets("LEASE", 1)
    start = now() + timedelta(days=4, hours=3)
    return create_booking(42, "Клиент", "@client", start, start + timedelta(hours=2),
                          [{"article_id": article_id, "quantity": 1}])


def test_operator_claim_blocks_same_stage_and_release_allows_handoff():
    booking_id = pending_booking()
    lease = claim_booking_operation(booking_id, 100, "Анна")
    assert lease["actor_name"] == "Анна"
    with pytest.raises(Conflict, match="Анна"):
        claim_booking_operation(booking_id, 200, "Борис")
    with pytest.raises(Conflict, match="Анна"):
        transition(booking_id, "confirmed", 200)
    release_booking_operation(booking_id, 100)
    assert transition(booking_id, "confirmed", 200) == "confirmed"


def test_bot_fallback_respects_current_claim():
    booking_id = pending_booking()
    claim_booking_operation(booking_id, 100, "Анна")
    with pytest.raises(LegacyConflict, match="Анна"):
        legacy_transition(booking_id, "confirmed", 200)


def test_claim_expires_and_stage_change_releases_it():
    booking_id = pending_booking()
    claim_booking_operation(booking_id, 100, "Анна")
    with Session.begin() as session:
        session.get(BookingOperationLease, (booking_id, "pending")).expires_at = now() - timedelta(seconds=1)
    claim_booking_operation(booking_id, 200, "Борис")
    assert transition(booking_id, "confirmed", 200) == "confirmed"
    claim_booking_operation(booking_id, 100, "Анна")


def test_identity_review_claim_does_not_block_workflow_stage():
    booking_id = pending_booking()
    claim_booking_operation(booking_id, 100, "Анна", "identity_review")
    assert transition(booking_id, "confirmed", 200) == "confirmed"
    release_booking_operation(booking_id, 100, "identity_review")


def test_admin_api_shows_holder_and_rejects_competing_claim(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    first = {"X-Telegram-Init-Data": signed_init_data(100)}
    second = {"X-Telegram-Init-Data": signed_init_data(200)}
    with TestClient(app) as client:
        claim = client.post(f"/api/miniapp/admin/bookings/{booking_id}/operation", headers=first)
        assert claim.status_code == 200
        items = client.get("/api/miniapp/admin/bookings", headers=second).json()["items"]
        assert next(item for item in items if item["id"] == booking_id)["operation_lease"]["actor_id"] == 100
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/operation", headers=second).status_code == 409
        assert client.delete(f"/api/miniapp/admin/bookings/{booking_id}/operation", headers=first).status_code == 200
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/operation", headers=second).status_code == 200
