"""Transactional catalog chat checks against the isolated PostgreSQL fixture."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import func, select
from app import chat_catalog as catalog
from app.db import Article, Equipment, Session


class MemoryState:
    def __init__(self): self.data={}; self.state=None
    async def clear(self): self.data={}; self.state=None
    async def update_data(self, **values): self.data.update(values)
    async def get_data(self): return dict(self.data)
    async def set_state(self, value): self.state=value.state
    async def get_state(self): return self.state


def test_chat_csv_preview_confirm_and_duplicate_press(monkeypatch):
    monkeypatch.setattr(catalog,'private',lambda _: True)
    data=('sku;name;serial\nCHAT-SKU;Камера;S-1\nCHAT-SKU;Камера;S-2\n').encode()
    user=SimpleNamespace(id=100)
    state=MemoryState()
    message=SimpleNamespace(document=SimpleNamespace(file_name='catalog.csv',file_size=len(data)),from_user=user,answer=AsyncMock())
    async def download(_file,destination,seek): destination.write(data);destination.flush()
    asyncio.run(catalog.import_file(message,state,SimpleNamespace(download=download)))
    assert state.state==catalog.CatalogImport.confirm.state
    with Session() as session: assert session.scalar(select(func.count()).select_from(Article)) == 0
    nonce=state.data['csv_nonce']
    query=SimpleNamespace(data=f'ci:save:{nonce}',from_user=user,answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(catalog.import_save(query,state))
    asyncio.run(catalog.import_save(query,state))
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(Article)) == 1
        assert session.scalar(select(func.count()).select_from(Equipment)) == 2
    assert query.answer.call_args.kwargs['show_alert']


def test_model_editor_rejects_concurrent_change(monkeypatch):
    import pytest
    from app.rental import save_article, list_articles, Conflict
    article_id=save_article('EDIT-SKU','До','Описание',0,actor_id=100)
    original=next(row for row in list_articles() if row.id==article_id)
    before=catalog.snapshot_fields(original,catalog.ARTICLE_FIELDS)
    save_article('EDIT-SKU','Другое изменение','Описание',0,article_id=article_id,actor_id=100)
    with pytest.raises(Conflict,match='изменилась'):
        save_article('EDIT-SKU','Устаревшее изменение','Описание',0,article_id=article_id,actor_id=100,expected_before=before)
    assert next(row for row in list_articles() if row.id==article_id).name=='Другое изменение'


def test_asset_editor_rejects_concurrent_change(monkeypatch):
    import pytest
    from app.rental import save_article, save_equipment, list_equipment, Conflict
    article_id=save_article('EDIT-ASSET','Камера','',0,actor_id=100)
    asset_id=save_equipment('','','',0,'available',article_id=article_id,serial_number='S')
    asset=next(row for row in list_equipment() if row.id==asset_id)
    before=catalog.snapshot_fields(asset,catalog.ASSET_FIELDS)
    save_equipment('','','',0,'maintenance',equipment_id=asset_id,article_id=article_id,serial_number='S')
    with pytest.raises(Conflict,match='изменилась'):
        save_equipment('','','',0,'available',equipment_id=asset_id,article_id=article_id,serial_number='S',expected_before=before)
    assert next(row for row in list_equipment() if row.id==asset_id).condition=='maintenance'


def test_chat_create_article_and_asset_through_editor(monkeypatch):
    monkeypatch.setattr(catalog,'private',lambda _:True)
    user=SimpleNamespace(id=100)
    state=MemoryState()
    query=SimpleNamespace(data='ce:newarticle',from_user=user,answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(catalog.editor_action(query,state))
    message=SimpleNamespace(text='sku=CHAT-CREATE\nname=Камера',from_user=user,answer=AsyncMock())
    asyncio.run(catalog.editor_input(message,state))
    assert state.state == catalog.CatalogEditor.confirm.state
    query.data='ce:save:'+state.data['editor_nonce']
    asyncio.run(catalog.editor_action(query,state))
    with Session() as session: article=session.scalar(select(Article).where(Article.sku=='CHAT-CREATE')); article_id=article.id
    query.data=f'ce:newasset:{article_id}'
    asyncio.run(catalog.editor_action(query,state))
    message.text='location=A-10'
    asyncio.run(catalog.editor_input(message,state))
    assert state.state == catalog.CatalogEditor.confirm.state
    query.data='ce:save:'+state.data['editor_nonce']
    asyncio.run(catalog.editor_action(query,state))
    with Session() as session:
        asset=session.scalar(select(Equipment).where(Equipment.article_id==article_id))
        assert asset.storage_location=='A-10' and asset.serial_number is None


def test_chat_model_photo_uses_catalog_thumbnail(monkeypatch):
    import io
    from PIL import Image
    from app.db import ArticleImage
    from app.rental import save_article
    monkeypatch.setattr(catalog,'private',lambda _:True)
    article_id=save_article('PHOTO-CHAT','Камера','',0,actor_id=100)
    output=io.BytesIO();Image.new('RGB',(30,30),'blue').save(output,format='PNG');raw=output.getvalue()
    state=MemoryState();state.data={'photo_article_id':article_id};state.state=catalog.CatalogPhoto.upload.state
    message=SimpleNamespace(from_user=SimpleNamespace(id=100),photo=[],document=SimpleNamespace(mime_type='image/png',file_size=len(raw)),answer=AsyncMock())
    async def download(_file,destination,seek): destination.write(raw);destination.flush()
    asyncio.run(catalog.catalog_photo_upload(message,state,SimpleNamespace(download=download)))
    with Session() as session: assert session.get(ArticleImage,article_id).webp.startswith(b'RIFF')
    assert state.state is None


def test_chat_category_creation_requires_confirm(monkeypatch):
    from app.catalog_categories import list_categories
    monkeypatch.setattr(catalog,'private',lambda _:True)
    user=SimpleNamespace(id=100);state=MemoryState()
    message=SimpleNamespace(text='Звук',from_user=user,answer=AsyncMock())
    asyncio.run(catalog.category_input(message,state))
    assert all(row['name']!='Звук' for row in list_categories())
    query=SimpleNamespace(data='cc:save:'+state.data['category_nonce'],from_user=user,answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(catalog.category_save(query,state))
    assert any(row['name']=='Звук' for row in list_categories())
