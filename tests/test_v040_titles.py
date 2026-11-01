import json
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.catalog_titles import catalog_title, infer_structured
from app.db import Article, ArticleTitleAudit, Session
from app.miniapp_server import app
from app.rental import availability, now
from tests.test_miniapp import configure, signed_init_data


def test_title_rules_and_fallback():
    parts = infer_structured("Карта памяти Lexar SDXC 256GB Professional")
    assert catalog_title("original", **parts) == "original"
    assert catalog_title("Original model", "", "", "") == "Original model"
    assert catalog_title("Original", "lens", "", "24–70 мм") == "Original"
    assert infer_structured("Штатив Manfrotto 160 см")["key_spec"] == "160 см"


def test_staff_can_edit_separate_fields_and_audit(monkeypatch):
    configure(monkeypatch)
    headers = {"X-Telegram-Init-Data": signed_init_data(100)}
    payload = {"sku": "TITLE-1", "name": "Lexar SDXC 256GB original", "category": "accessory",
               "kind": "memory_card", "brand": "Lexar", "key_spec": "256GB"}
    with TestClient(app) as client:
        denied = client.post("/api/miniapp/admin/catalog/articles", json=payload,
                             headers={"X-Telegram-Init-Data": signed_init_data(42)})
        assert denied.status_code == 403
        response = client.post("/api/miniapp/admin/catalog/articles", json=payload, headers=headers)
        assert response.status_code == 200, response.text
        article_id = response.json()["id"]
        row = next(x for x in client.get("/api/miniapp/admin/catalog", headers=headers).json()["articles"] if x["id"] == article_id)
        assert row["name"] == payload["name"] and row["title"] == payload["name"]
        # Old clients omitting the new fields do not erase them.
        old_payload = {k: v for k, v in payload.items() if k not in {"kind", "brand", "key_spec"}}
        old_payload["id"] = article_id
        assert client.post("/api/miniapp/admin/catalog/articles", json=old_payload, headers=headers).status_code == 200
        with Session() as session:
            article = session.get(Article, article_id)
            assert (article.kind, article.brand, article.key_spec) == ("memory_card", "Lexar", "256GB")
            audit = session.scalars(select(ArticleTitleAudit).where(ArticleTitleAudit.article_id == article_id)).all()
            assert len(audit) == 1 and audit[0].actor_id == 100
            assert json.loads(audit[0].after)["name"] == payload["name"]
        start = now() + timedelta(days=5)
        item = next(item for item in availability(start, start + timedelta(hours=1)) if item["id"] == article_id)
        assert item["title"] == row["title"]
        response = client.get("/api/miniapp/availability", params={"start": start.isoformat(),
                                                                    "end": (start + timedelta(hours=1)).isoformat()})
        data = response.json()
        unavailable = next(item for item in data["all_items"] if item["id"] == article_id)
        assert unavailable["available"] is False and unavailable["title"] == row["title"]
        assert all(item["id"] != article_id for item in data["items"])
