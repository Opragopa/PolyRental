import base64
from datetime import timedelta
import io

from fastapi.testclient import TestClient
from PIL import Image
import pytest
from sqlalchemy import select

from app.catalog_images import MAX_PREVIEW, MAX_UPLOAD, save_image, thumbnail
from app.db import ArticleImage, Session
from app.miniapp_server import app
from app.rental import availability, now
from app.storage_monitor import evaluate_storage, storage_report
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def test_model_photo_upload_embeds_sanitized_preview_and_enforces_roles(monkeypatch):
    configure(monkeypatch)
    article_id = article_with_assets("PHOTO", 1)
    source = io.BytesIO()
    image = Image.new("RGB", (2400, 1200), "red")
    exif = Image.Exif()
    exif[270] = "private camera metadata"
    image.save(source, format="JPEG", exif=exif)
    headers = lambda user: {"X-Telegram-Init-Data": signed_init_data(user)}
    endpoint = f"/api/miniapp/admin/catalog/articles/{article_id}/photo"
    with TestClient(app) as client:
        assert client.put(endpoint, files={"photo": ("x.jpg", source.getvalue(), "image/jpeg")}, headers=headers(42)).status_code == 403
        assert client.put(endpoint, files={"photo": ("x.jpg", source.getvalue(), "image/jpeg")}, headers=headers(100)).status_code == 200
        start = now() + timedelta(days=5)
        public = next(row for row in availability(start, start + timedelta(hours=2)) if row["id"] == article_id)
        encoded = public["image_data"].split(",", 1)[1]
        raw = base64.b64decode(encoded)
        assert len(raw) <= MAX_PREVIEW and b"private camera metadata" not in raw
        with Image.open(io.BytesIO(raw)) as preview:
            assert preview.format == "WEBP" and preview.size == (640, 320) and not preview.getexif()
        admin = client.get("/api/miniapp/admin/catalog", headers=headers(100)).json()
        assert admin["articles"][0]["image_data"] == public["image_data"]
        assert client.put(endpoint, files={"photo": ("bad.png", b"bad", "image/png")}, headers=headers(100)).status_code == 422
        with Session() as session:
            assert session.scalar(select(ArticleImage.webp)) == raw
        assert client.delete(endpoint, headers=headers(100)).status_code == 200
        assert not availability(start, start + timedelta(hours=2))[0]["image_data"]


def test_model_photo_rejects_oversized_and_missing_models(monkeypatch):
    configure(monkeypatch)
    with pytest.raises(ValueError):
        thumbnail(b"x" * (MAX_UPLOAD + 1))
    with pytest.raises(ValueError):
        thumbnail(b"<svg></svg>")
    with pytest.raises(ValueError):
        save_image(9999999, None, 100)


def test_storage_thresholds_and_read_only_metadata_report(tmp_path):
    assert evaluate_storage(9, [4, 5], 1, database_limit=10, backup_limit=10) == []
    assert evaluate_storage(10, [10], None, database_limit=10, backup_limit=10) == [
        "database_size", "backup_size", "backup_stale_or_missing"]
    assert evaluate_storage(0, [], 26) == ["backup_stale_or_missing"]
    report = storage_report(tmp_path)
    assert report["database_bytes"] > 0 and report["backup_count"] == 0
    assert report["alerts"] == ["backup_stale_or_missing"]
    (tmp_path / "polyrental-synthetic.prbak").write_bytes(b"not a real backup")
    report = storage_report(tmp_path, database_limit=1, backup_limit=1)
    assert report["backup_count"] == 1 and report["alerts"] == ["database_size", "backup_size"]
    # Monitoring observes freshness and sizes; restore verification is a separate command.
    assert report["largest_tables"]
