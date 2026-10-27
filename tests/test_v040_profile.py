from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.client_profile import complete_onboarding, mark_onboarding_shown
from app.db import Booking, ClientActivity, ClientProfile, Session
from app.rental import now
from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def test_onboarding_once_concurrent_and_completion_idempotent():
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(mark_onboarding_shown, [42] * 8))
    assert sum(results) == 1
    complete_onboarding(42)
    complete_onboarding(42)
    with Session() as session:
        assert session.get(ClientProfile, 42).onboarding_shown_at
        actions = session.scalars(select(ClientActivity.action).where(ClientActivity.telegram_id == 42)).all()
        assert sorted(actions) == ["onboarding_completed", "onboarding_first_shown"]


def test_profile_entry_permissions_and_independent_onboarding(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/miniapp/profile").status_code == 401
        customer = client.get("/api/miniapp/profile", headers=headers(42)).json()
        operator = client.get("/api/miniapp/profile", headers=headers(100)).json()
        assert customer["start_screen"] == "booking" and operator["start_screen"] == "management"
        assert not customer["onboarding_seen"] and not operator["onboarding_seen"]
        assert client.post("/api/miniapp/operator/client-mode", headers=headers(42)).status_code == 403
        assert client.post("/api/miniapp/operator/client-mode", headers=headers(100)).status_code == 200
        assert client.post("/api/miniapp/onboarding/show", headers=headers(100)).json()["first_show"]
        assert not client.post("/api/miniapp/onboarding/show", headers=headers(100)).json()["first_show"]
        assert not client.get("/api/miniapp/profile", headers=headers(42)).json()["onboarding_seen"]
        assert client.post("/api/miniapp/onboarding/complete", headers=headers(100)).status_code == 200
        with Session() as session:
            actions = session.scalars(select(ClientActivity.action).where(ClientActivity.telegram_id == 100)).all()
            assert sorted(actions) == ["onboarding_completed", "onboarding_first_shown", "operator_client_mode"]


def test_reminder_preference_is_private_and_strict(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        url = "/api/miniapp/profile/reminders"
        assert client.put(url, json={"enabled": False}).status_code == 401
        assert client.put(url, headers=headers(42), json={"enabled": "false"}).status_code == 422
        for _ in range(2):
            assert client.put(url, headers=headers(42), json={"enabled": False}).json() == {"enabled": False}
        assert client.get("/api/miniapp/profile", headers=headers(42)).json()["reminders_enabled"] is False
        assert client.get("/api/miniapp/profile", headers=headers(43)).json()["reminders_enabled"] is True
        assert client.put(url, headers=headers(42), json={"enabled": True, "id": 43}).status_code == 422


def test_profile_history_is_paginated_filtered_and_customer_scoped(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        for index in range(14):
            session.add(Booking(customer_id=42, customer_name="Клиент", customer_contact="@qa",
                                starts_at=now(), ends_at=now() + timedelta(hours=1),
                                status="pending" if index < 12 else "returned"))
        session.add(Booking(customer_id=43, customer_name="Другой", customer_contact="@other",
                            starts_at=now(), ends_at=now() + timedelta(hours=1), status="pending"))
    with TestClient(app) as client:
        assert client.get("/api/miniapp/profile/history").status_code == 401
        first = client.get("/api/miniapp/profile/history?category=active&page=0", headers=headers(42)).json()
        second = client.get("/api/miniapp/profile/history?category=active&page=1", headers=headers(42)).json()
        completed = client.get("/api/miniapp/profile/history?category=completed", headers=headers(42)).json()
        assert first["total"] == 12 and len(first["items"]) == 10 and len(second["items"]) == 2
        assert len(completed["items"]) == 2 and all(x["status"] == "returned" for x in completed["items"])
        assert not ({x["id"] for x in first["items"]} & {x["id"] for x in second["items"]})
        assert client.get("/api/miniapp/profile/history?category=other", headers=headers(42)).status_code == 422
