from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Article, BookingAsset, BookingLine, Equipment, RepairTicket, Session
from app.catalog_import import import_catalog_csv
from app.miniapp_server import app
from app.rental import Conflict, create_booking, get_booking, now, save_article, save_dependency, save_equipment
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def test_admin_removes_article_from_future_use_but_preserves_history(monkeypatch):
    configure(monkeypatch)
    article_id = article_with_assets("ARCHIVE", 2)
    start = now() + timedelta(days=5)
    end = start + timedelta(days=1)
    booking_id = create_booking(42, "Анна", "@anna_user", start, end,
                                [{"article_id": article_id, "quantity": 1}])
    with Session() as session:
        ids = list(session.scalars(select(Equipment.id).where(Equipment.article_id == article_id)))
        article = session.get(Article, article_id)
        sku, name = article.sku, article.name
    with Session.begin() as session:
        line = session.scalar(select(BookingLine).where(BookingLine.booking_id == booking_id))
        session.add(BookingAsset(booking_id=booking_id, booking_line_id=line.id, equipment_id=ids[0]))
        session.add(RepairTicket(equipment_id=ids[1], defect="Прошлый ремонт", status="closed"))

    endpoint = f"/api/miniapp/admin/catalog/articles/{article_id}"
    with TestClient(app) as client:
        assert client.delete(endpoint, headers=headers(42)).status_code == 403
        assert client.delete(endpoint, headers=headers(200)).status_code == 403
        result = client.delete(endpoint, headers=headers(100))
        assert result.status_code == 200
        assert result.json() == {"article_id": article_id, "equipment_count": 2}
        assert client.delete(endpoint, headers=headers(100)).status_code == 409
        assert all(row["id"] != article_id for row in client.get("/api/miniapp/catalog").json()["items"])
        assert all(row["id"] != article_id for row in client.get(
            "/api/miniapp/admin/catalog/options", headers=headers(100)).json()["items"])
        assert all(row["id"] != article_id for row in client.get(
            "/api/miniapp/admin/catalog", headers=headers(100)).json()["articles"])

    with Session() as session:
        archived = session.get(Article, article_id)
        assert archived.archived_at is not None and archived.archived_by == 100 and not archived.is_active
        assert all(session.get(Equipment, asset_id).article_id == article_id for asset_id in ids)
        assert session.scalar(select(BookingLine.id).where(BookingLine.booking_id == booking_id,
                                                            BookingLine.article_id == article_id))
        assert session.get(BookingAsset, (booking_id, ids[0])) is not None
        assert session.scalar(select(RepairTicket.id).where(RepairTicket.equipment_id == ids[1]))
    assert get_booking(booking_id).lines[0].article.name == name
    with pytest.raises(Conflict, match="недоступен"):
        create_booking(43, "Иван", "@ivan_user", start, end,
                       [{"article_id": article_id, "quantity": 1}])
    with pytest.raises(Conflict, match="удалён"):
        save_article(sku, name, "", 0, article_id=article_id, active=True)
    with pytest.raises(Conflict, match="удалён"):
        save_equipment("", "", "", 0, "available", article_id=article_id)
    with pytest.raises(ValueError, match="удалён"):
        import_catalog_csv(f"sku;name;serial\n{sku};{name};NEW-SERIAL\n".encode())
    other = article_with_assets("ARCHIVE-OTHER", 1)
    with pytest.raises(Conflict, match="Удалённый"):
        save_dependency(other, article_id)
    with pytest.raises(Conflict, match="удалённого"):
        save_equipment("", "", "", 0, "available", equipment_id=ids[0], article_id=other)


def test_article_archive_missing_and_role_boundary(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        assert client.delete("/api/miniapp/admin/catalog/articles/999999999", headers=headers(100)).status_code == 404
        assert client.delete("/api/miniapp/admin/catalog/articles/999999999").status_code == 401


def test_archive_wins_against_booking_started_with_stale_catalog(monkeypatch):
    import app.rental as rental
    configure(monkeypatch)
    article_id = article_with_assets("ARCHIVE-RACE", 1)
    start = now() + timedelta(days=5)
    selected, resume = Event(), Event()
    original = rental._normalize_lines

    def delayed_selection(session, requested):
        rows = original(session, requested)
        selected.set()
        assert resume.wait(10)
        return rows

    monkeypatch.setattr(rental, "_normalize_lines", delayed_selection)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(create_booking, 42, "Анна", "@anna_user", start,
                             start + timedelta(days=1), [{"article_id": article_id, "quantity": 1}])
        try:
            assert selected.wait(10)
            rental.archive_article(article_id, 100)
        finally:
            resume.set()
        with pytest.raises(Conflict, match="недоступен"):
            future.result(timeout=10)
