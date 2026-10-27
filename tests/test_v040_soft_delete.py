from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Audit, Booking, BookingLine, Session
from app.miniapp_server import app
from app.rental import availability, create_booking, get_booking, transition
from tests.test_miniapp import configure, signed_init_data
from tests.test_operation_lease import pending_booking


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def finish_scheduled(response):
    from datetime import timedelta
    from app.db import DeletionIntent
    from app.rental import expire_deletion_intents, now
    assert response.status_code == 200
    with Session.begin() as session:
        session.get(DeletionIntent, response.json()["intent_id"]).expires_at = now() - timedelta(seconds=1)
    expire_deletion_intents()


def test_soft_delete_restore_is_scoped_idempotent_and_preserves_relations(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    article_id = booking.lines[0].article_id
    before = next(item for item in availability(booking.starts_at, booking.ends_at) if item["id"] == article_id)
    assert before["available"] is True
    url = f"/api/miniapp/admin/bookings/{booking_id}"
    with TestClient(app) as client:
        assert client.delete(url, headers=headers(42)).status_code == 403
        first = client.delete(url, headers=headers(100))
        second = client.delete(url, headers=headers(100))
        assert first.json()["intent_id"] == second.json()["intent_id"]
        finish_scheduled(first)
        assert client.delete(url, headers=headers(100)).status_code == 200
        assert get_booking(booking_id) is None
        assert not client.get('/api/miniapp/bookings', headers=headers(42)).json()['items']
        assert availability(booking.starts_at, booking.ends_at)[0]['available_quantity'] == 1
        with Session() as session:
            assert session.get(Booking, booking_id).deleted_at is not None
            assert session.scalar(select(BookingLine.id).where(BookingLine.booking_id == booking_id))
        assert client.post(url + '/restore', headers=headers(200)).status_code == 403
        assert client.post(url + '/restore', headers=headers(100)).status_code == 200
        assert client.post(url + '/restore', headers=headers(100)).status_code == 200
        assert get_booking(booking_id).lines[0].article_id == article_id
        assert availability(booking.starts_at, booking.ends_at)[0]['available_quantity'] == 1
        with Session() as session:
            actions = session.scalars(select(Audit.action).where(Audit.booking_id == booking_id)).all()
            assert actions.count('request_deleted') == 1 and actions.count('request_restored') == 1


def test_restore_rechecks_availability_and_nonpending_delete_fails(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    url = f"/api/miniapp/admin/bookings/{booking_id}"
    with TestClient(app) as client:
        finish_scheduled(client.delete(url, headers=headers(100)))
        new_id = create_booking(43, 'Другой', '@other', booking.starts_at, booking.ends_at,
                                [{'article_id': booking.lines[0].article_id, 'quantity': 1}])
        assert client.post(url + '/restore', headers=headers(100)).status_code == 200
        assert get_booking(booking_id) is not None
        transition(new_id, 'confirmed', 100)
        from app.rental import Conflict
        import pytest
        with pytest.raises(Conflict):
            transition(booking_id, 'confirmed', 100)
        assert client.delete(f'/api/miniapp/admin/bookings/{new_id}', headers=headers(100)).status_code == 409


def test_soft_delete_line_keeps_history_and_blocks_empty_confirmation(monkeypatch):
    configure(monkeypatch)
    booking_id = pending_booking()
    booking = get_booking(booking_id)
    line_id = booking.lines[0].id
    url = f"/api/miniapp/admin/bookings/{booking_id}/lines/{line_id}"
    with TestClient(app) as client:
        assert client.delete(url, headers=headers(42)).status_code == 403
        first = client.delete(url, headers=headers(100))
        second = client.delete(url, headers=headers(100))
        assert first.json()["intent_id"] == second.json()["intent_id"]
        finish_scheduled(first)
        assert client.delete(url, headers=headers(100)).status_code == 200
        assert not get_booking(booking_id).lines
        assert availability(booking.starts_at, booking.ends_at)[0]["available_quantity"] == 1
        assert client.post(f"/api/miniapp/admin/bookings/{booking_id}/transition", headers=headers(100), json={"action": "confirmed"}).status_code == 409
        assert client.post(url + "/restore", headers=headers(200)).status_code == 403
        assert client.post(url + "/restore", headers=headers(100)).status_code == 200
        assert get_booking(booking_id).lines[0].id == line_id
        history = client.get(f"/api/miniapp/admin/bookings/{booking_id}/history", headers=headers(100)).json()["items"]
        actions = [item["action"] for item in history]
        assert actions.count(f"line_deleted:{line_id}") == 1
        assert actions.count(f"line_restored:{line_id}") == 1


def test_asset_removal_keeps_inspection_and_restore_relations(monkeypatch):
    configure(monkeypatch)
    from datetime import timedelta
    from app.db import Inspection
    from app.rental import assign_booking_assets, now, record_inspection
    from tests.test_integration import article_with_assets
    article_id = article_with_assets("ASSET-UNDO", 2)
    start = now() + timedelta(days=5)
    booking_id = create_booking(42, "QA", "@qa_user", start, start + timedelta(hours=1),
                                [{"article_id": article_id, "quantity": 2}])
    transition(booking_id, "confirmed", 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    assign_booking_assets(booking_id, 100)
    asset_id = get_booking(booking_id).assets[0].equipment_id
    record_inspection(booking_id, asset_id, "pre_issue", "pass", {}, "", 100)
    url = f"/api/miniapp/admin/bookings/{booking_id}/assets/{asset_id}"
    with TestClient(app) as client:
        assert client.delete(url, headers=headers(200)).status_code == 409
        finish_scheduled(client.delete(url, headers=headers(100)))
        saved = get_booking(booking_id)
        assert len(saved.assets) == 1 and saved.lines[0].quantity == 1
        with Session() as session:
            assert session.scalar(select(Inspection.id).where(Inspection.booking_id == booking_id,
                                                              Inspection.equipment_id == asset_id))
        assert client.post(url + "/restore", headers=headers(100)).status_code == 200
        restored = get_booking(booking_id)
        assert len(restored.assets) == 2 and restored.lines[0].quantity == 2


def test_undo_intent_is_audited_and_cannot_commit_after_cancel(monkeypatch):
    from uuid import uuid4
    configure(monkeypatch)
    booking_id = pending_booking()
    line_id = get_booking(booking_id).lines[0].id
    intent_id = str(uuid4())
    base = f"/api/miniapp/admin/bookings/{booking_id}"
    body = {"id":intent_id, "target_type":"line", "target_id":line_id}
    with TestClient(app) as client:
        for _ in range(2):
            assert client.post(base + "/deletion-intents", headers=headers(100), json=body).status_code == 200
        for _ in range(2):
            assert client.post(base + f"/deletion-intents/{intent_id}/cancel", headers=headers(100)).status_code == 200
        assert client.delete(base + f"/lines/{line_id}?intent={intent_id}", headers=headers(100)).status_code == 409
        assert get_booking(booking_id).lines[0].id == line_id
        with Session() as session:
            actions = session.scalars(select(Audit.action).where(Audit.booking_id == booking_id)).all()
            assert actions.count(f"line_delete_intent:{line_id}") == 1
            assert actions.count(f"line_delete_undo:{line_id}") == 1


def test_expired_intent_commits_after_client_disconnect(monkeypatch):
    from datetime import timedelta
    from uuid import uuid4
    from app.db import DeletionIntent
    from app.rental import expire_deletion_intents, now
    configure(monkeypatch)
    booking_id = pending_booking()
    line_id = get_booking(booking_id).lines[0].id
    intent_id = str(uuid4())
    base = f"/api/miniapp/admin/bookings/{booking_id}"
    with TestClient(app) as client:
        assert client.post(base + "/deletion-intents", headers=headers(100), json={"id":intent_id,"target_type":"line","target_id":line_id}).status_code == 200
        assert client.delete(base + f"/lines/{line_id}?intent={intent_id}", headers=headers(100)).status_code == 409
        with Session.begin() as session:
            session.get(DeletionIntent, intent_id).expires_at = now() - timedelta(seconds=1)
        expire_deletion_intents()
        expire_deletion_intents()
        assert not get_booking(booking_id).lines
        assert client.post(base + f"/deletion-intents/{intent_id}/cancel", headers=headers(100)).status_code == 409
        with Session() as session:
            assert session.get(DeletionIntent, intent_id).status == "committed"


def test_new_delete_intent_commits_previous_only_with_valid_replacement(monkeypatch):
    from uuid import uuid4
    configure(monkeypatch)
    booking_id = pending_booking()
    line_id = get_booking(booking_id).lines[0].id
    first, second = str(uuid4()), str(uuid4())
    base = f"/api/miniapp/admin/bookings/{booking_id}"
    with TestClient(app) as client:
        assert client.post(base + "/deletion-intents", headers=headers(100), json={"id":first,"target_type":"line","target_id":line_id}).status_code == 200
        assert client.delete(base + f"/lines/{line_id}?intent={first}&replacement={second}", headers=headers(100)).status_code == 409
        assert client.post(base + "/deletion-intents", headers=headers(100), json={"id":second,"target_type":"request","target_id":None}).status_code == 200
        assert client.delete(base + f"/lines/{line_id}?intent={first}&replacement={second}", headers=headers(100)).status_code == 200
        assert client.post(base + f"/deletion-intents/{second}/cancel", headers=headers(100)).status_code == 200
        assert get_booking(booking_id).lines == []
