from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Article, CatalogCategory, Session, StaffRole
from app.miniapp_server import app
from tests.test_article_archive import headers
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure


def test_operator_categories_and_hide_permissions(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        session.get(StaffRole, 200).role = 'operator'
    article_id = article_with_assets('ROLE-CATALOG', 1)
    with TestClient(app) as client:
        operator = headers(200)
        assert client.post('/api/miniapp/admin/catalog/categories', headers=headers(42), json={'name':'Чужая'}).status_code == 403
        result = client.post('/api/miniapp/admin/catalog/categories', headers=operator, json={'name':'Операторская'})
        assert result.status_code == 200
        code = result.json()['code']
        child = client.post('/api/miniapp/admin/catalog/categories', headers=operator, json={'name':'Вложенная', 'parent_code':code}).json()['code']
        assert client.delete(f'/api/miniapp/admin/catalog/categories/{code}', headers=operator).status_code == 409
        assert client.delete(f'/api/miniapp/admin/catalog/categories/{child}', headers=operator).status_code == 200
        with Session.begin() as session:
            session.get(Article, article_id).category = code
        assert client.delete(f'/api/miniapp/admin/catalog/categories/{code}', headers=operator).status_code == 409
        assert client.post('/api/miniapp/admin/catalog/articles', headers=operator, json={'sku':'OTHER','name':'Запрещено'}).status_code == 403
        assert client.post('/api/miniapp/admin/catalog/equipment', headers=operator, json={'article_id':article_id}).status_code == 403
        assert client.post(f'/api/miniapp/admin/catalog/articles/{article_id}/hide', headers=operator).status_code == 200
        assert all(item['id'] != article_id for item in client.get('/api/miniapp/catalog').json()['items'])
        with Session.begin() as session:
            session.get(Article, article_id).category = 'generic'
        assert client.delete(f'/api/miniapp/admin/catalog/categories/{code}', headers=operator).status_code == 200
        assert client.delete('/api/miniapp/admin/catalog/categories/generic', headers=operator).status_code == 409


def test_category_with_only_archived_articles_can_be_removed_without_losing_history(monkeypatch):
    from app.catalog_categories import seed_categories
    from app.db import engine
    from app.rental import archive_article
    configure(monkeypatch)
    article_id = article_with_assets('ARCHIVED-CATEGORY', 1)
    with TestClient(app) as client:
        category = client.post('/api/miniapp/admin/catalog/categories', headers=headers(100), json={'name':'Архивная мебель'}).json()
        code = category['code']
        with Session.begin() as session:
            session.get(Article, article_id).category = code
        archive_article(article_id, 100)
        assert client.delete(f'/api/miniapp/admin/catalog/categories/{code}', headers=headers(200)).status_code == 200
        with Session() as session:
            assert session.get(Article, article_id).archived_at is not None
            assert session.get(Article, article_id).category == code
            assert session.get(CatalogCategory, code) is None
        with engine.begin() as connection:
            seed_categories(connection)
        with Session() as session:
            assert session.get(CatalogCategory, code) is None


def test_catalog_capacity_excludes_unusable_assets_and_refreshes_selected_models(monkeypatch):
    from app.db import Equipment
    configure(monkeypatch)
    article_id = article_with_assets('CAPACITY', 4)
    empty_id = article_with_assets('EMPTY-CAPACITY', 1)
    with Session.begin() as session:
        assets = session.scalars(select(Equipment).where(Equipment.article_id == article_id).order_by(Equipment.id)).all()
        assets[0].condition = 'maintenance'
        assets[1].condition = 'retired'
        session.scalar(select(Equipment).where(Equipment.article_id == empty_id)).condition = 'maintenance'
    with TestClient(app) as client:
        response = client.get('/api/miniapp/catalog', params={'q':'EMPTY-CAPACITY', 'selected':article_id})
        assert response.status_code == 200
        data = response.json()
        assert next(item for item in data['items'] if item['id'] == empty_id)['capacity'] == 0
        assert next(item for item in data['selected_items'] if item['id'] == article_id)['capacity'] == 2
