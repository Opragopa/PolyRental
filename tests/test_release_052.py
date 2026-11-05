"""Release 0.5.2: calendar capacity, public composition and compact bot cards."""
from datetime import timedelta
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Equipment, Session
from app.miniapp_server import app
from app.rental import availability_page, calendar_availability, now, save_article
from app.roadmap import release_external_block, save_external_block
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def test_calendar_uses_quantities_external_blocks_and_releases(monkeypatch):
    configure(monkeypatch)
    camera = article_with_assets("CAL-CAM", 2)
    light = article_with_assets("CAL-LIGHT", 1)
    start = (now() + timedelta(days=4)).replace(hour=10, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=2)
    lines = [{"article_id": camera, "quantity": 2}, {"article_id": light, "quantity": 1}]
    check = lambda: calendar_availability(start, end, lines, start.date())
    assert check()["selected"] == "all"
    with Session() as session:
        camera_assets = session.scalars(select(Equipment.id).where(Equipment.article_id == camera)).all()
        light_asset = session.scalar(select(Equipment.id).where(Equipment.article_id == light))
    first = save_external_block(camera_assets[0], start, end, "Внешняя съёмка", 100)
    assert check()["selected"] == "partial"  # One position cannot be fulfilled in full.
    save_external_block(camera_assets[1], start, end, "Внешняя съёмка", 100)
    save_external_block(light_asset, start, end, "Внешняя съёмка", 100)
    result = check()
    assert result["selected"] == "none"
    assert result["days"][start.date().isoformat()] == "none"
    assert result["days"][(start + timedelta(days=1)).date().isoformat()] == "all"
    assert len(result["days"]) == 42
    release_external_block(first, 100)
    assert check()["selected"] == "partial"  # One unit is available even with neither line complete.


def test_public_composition_and_calendar_api_validation(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr("app.miniapp_server.retry_pending_notifications", AsyncMock())
    aid = save_article("SET-052", "Камера", "Описание", "0", composition="Камера\nКрышка\nКабель")
    assert availability_page(None, None)[0][0]["composition"] == "Камера\nКрышка\nКабель"
    start = now() + timedelta(days=4)
    body = {"start": start.isoformat(), "end": (start + timedelta(hours=2)).isoformat(),
            "first_day": start.date().isoformat(), "lines": [{"article_id": aid, "quantity": 1}]}
    with TestClient(app) as client:
        assert client.post("/api/miniapp/availability/calendar", json=body).status_code == 401
        headers = {"X-Telegram-Init-Data": signed_init_data(42)}
        result = client.post("/api/miniapp/availability/calendar", json=body, headers=headers)
        assert result.status_code == 200 and result.json()["selected"] == "none"
        assert client.post("/api/miniapp/availability/calendar", json={**body, "end": body["start"]}, headers=headers).status_code == 422
        assert client.post("/api/miniapp/availability/calendar", json={**body, "lines": []}, headers=headers).status_code == 422
