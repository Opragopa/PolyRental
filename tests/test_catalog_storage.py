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


def test_catalog_edit_rejects_stale_staff_form(monkeypatch):
    from app.db import Article, Equipment
    configure(monkeypatch)
    article_id = article_with_assets('STALE-PHOTO', 1)
    headers = {'X-Telegram-Init-Data': signed_init_data(100)}
    with Session.begin() as session:
        article = session.get(Article, article_id)
        original_name = article.name
        article.name = 'Изменено другим сотрудником'
        asset = session.scalar(select(Equipment).where(Equipment.article_id == article_id))
        asset_id = asset.id
        asset.storage_location = 'Новая ячейка'
    with TestClient(app) as client:
        response = client.post('/api/miniapp/admin/catalog/articles', headers=headers, json={
            'id':article_id, 'sku':'STALE-PHOTO-1', 'name':'Перезапись',
            'expected_before':{'name':original_name},
        })
        assert response.status_code == 409
        response = client.post('/api/miniapp/admin/catalog/equipment', headers=headers, json={
            'id':asset_id, 'article_id':article_id, 'condition':'available', 'location':'Старая ячейка',
            'expected_before':{'storage_location':''},
        })
        assert response.status_code == 409
        invalid = client.post('/api/miniapp/admin/catalog/articles', headers=headers, json={
            'id':article_id, 'sku':'STALE-PHOTO-1', 'name':'Перезапись', 'expected_before':{'not_a_field':'x'},
        })
        assert invalid.status_code == 422
    with Session() as session:
        assert session.get(Article, article_id).name == 'Изменено другим сотрудником'
        assert session.get(Equipment, asset_id).storage_location == 'Новая ячейка'


def test_staff_catalog_pagination_search_and_options(monkeypatch):
    from app.db import Article, Equipment, EquipmentFeature, EquipmentOwner
    configure(monkeypatch)
    with Session.begin() as session:
        for index in range(25):
            article = Article(sku=f'PAGING-{index:02}', name=f'Камера {index:02}', category='camera')
            session.add(article); session.flush()
            asset = Equipment(inventory_number=f'PAGING-{index:02}', name=article.name, description='', hourly_rate=0,
                              condition='maintenance' if index == 24 else 'available', article_id=article.id,
                              serial_number='SPECIAL-SERIAL' if index == 24 else None)
            session.add(asset); session.flush()
            if index == 24:
                session.add(EquipmentOwner(equipment_id=asset.id, name='Тестовый владелец', contact='@owner'))
                session.add(EquipmentFeature(equipment_id=asset.id, description='Проверочная особенность', actor_id=100, source='catalog'))
    headers = {'X-Telegram-Init-Data': signed_init_data(100)}
    with TestClient(app) as client:
        url='/api/miniapp/admin/catalog?page_size=10&page='
        first=client.get(url+'0', headers=headers).json()
        second=client.get(url+'1', headers=headers).json()
        third=client.get(url+'2', headers=headers).json()
        assert first['total']==25 and [len(part['articles']) for part in (first,second,third)]==[10,10,5]
        assert len({article['id'] for part in (first,second,third) for article in part['articles']})==25
        found=client.get(url+'0&q=SPECIAL-SERIAL', headers=headers).json()
        assert found['total']==1 and found['articles'][0]['sku']=='PAGING-24'
        assert found['articles'][0]['equipment'][0]['owner']=='Тестовый владелец'
        assert found['articles'][0]['equipment'][0]['features'][0]['description']=='Проверочная особенность'
        maintenance=client.get(url+'0&condition=maintenance', headers=headers).json()
        assert maintenance['total']==1 and maintenance['articles'][0]['sku']=='PAGING-24'
        options=client.get('/api/miniapp/admin/catalog/options?page=1&page_size=10', headers=headers).json()
        assert options['total']==25 and len(options['items'])==10 and 'equipment' not in options['items'][0]
        assert client.get(url+'0', headers={'X-Telegram-Init-Data':signed_init_data(42)}).status_code==403
        assert len(client.get('/api/miniapp/admin/catalog', headers=headers).json()['articles'])==25


@pytest.mark.parametrize("mode,format", [("RGBA","PNG"),("LA","PNG"),("P","PNG"),("RGBA","WEBP")])
def test_thumbnail_preserves_transparent_and_semitransparent_pixels(mode,format):
    from PIL import ImageDraw
    image=Image.new("RGBA",(1280,640),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    draw.rectangle((400,0,799,639),fill=(40,150,220,128))
    draw.rectangle((800,0,1279,639),fill=(220,50,40,255))
    if mode=="LA":image=image.convert("LA")
    if mode=="P":
        image=Image.new("P",(1280,640),0)
        image.putpalette([0,0,0,40,150,220,220,50,40]+[0]*759)
        image.paste(1,(400,0,800,640));image.paste(2,(800,0,1280,640))
        image.info['transparency']=bytes([0,128,255])
    source=io.BytesIO();image.save(source,format=format)
    raw=thumbnail(source.getvalue())
    assert len(raw)<=MAX_PREVIEW
    with Image.open(io.BytesIO(raw)) as result:
        assert result.size==(640,320)
        assert result.convert('RGBA').getpixel((50,100))[3]==0
        assert result.convert('RGBA').getpixel((300,100))[3]==128
        assert result.convert('RGBA').getpixel((550,100))[3]==255


def test_transparent_catalog_photo_survives_upload_storage_and_public_api(monkeypatch):
    configure(monkeypatch)
    article_id=article_with_assets('ALPHA-PHOTO',1)
    image=Image.new('RGBA',(80,40),(0,0,0,0))
    image.paste((255,70,20,128),(20,0,60,40))
    source=io.BytesIO();image.save(source,format='PNG')
    headers={'X-Telegram-Init-Data':signed_init_data(100)}
    with TestClient(app) as client:
        response=client.put(f'/api/miniapp/admin/catalog/articles/{article_id}/photo',
            headers=headers,files={'photo':('transparent.png',source.getvalue(),'image/png')})
        assert response.status_code==200,response.text
        item=next(item for item in client.get('/api/miniapp/catalog').json()['items'] if item['id']==article_id)
        data=base64.b64decode(item['image_data'].split(',',1)[1])
        with Session() as session:assert session.get(ArticleImage,article_id).webp==data
        with Image.open(io.BytesIO(data)) as result:
            assert result.convert('RGBA').getpixel((5,5))[3]==0
            assert result.convert('RGBA').getpixel((40,5))[3]==128
