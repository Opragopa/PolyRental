import asyncio
import base64
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import chat_catalog as catalog


def test_import_checks_role_before_write(monkeypatch):
    monkeypatch.setattr(catalog, 'private', lambda _: True)
    monkeypatch.setattr(catalog, 'staff_allows', lambda *_: False)
    imported=AsyncMock(); monkeypatch.setattr(catalog, 'import_catalog_csv', imported)
    query=SimpleNamespace(data='ci:save:abc',from_user=SimpleNamespace(id=501),answer=AsyncMock())
    asyncio.run(catalog.import_save(query,SimpleNamespace()))
    imported.assert_not_called(); assert query.answer.call_args.kwargs['show_alert']


def test_import_consumes_confirmation_before_transaction(monkeypatch):
    monkeypatch.setattr(catalog, 'private', lambda _: True)
    monkeypatch.setattr(catalog, 'staff_allows', lambda *_: True)
    events=[]
    def run_import(raw):
        assert events == ['cleared']
        assert raw == b'csv'
        return {'articles_created':1,'equipment_created':2}
    monkeypatch.setattr(catalog, 'import_catalog_csv', run_import)
    async def clear(): events.append('cleared')
    data={'csv_nonce':'valid','csv_at':time.time(),'csv_data':base64.b64encode(b'csv').decode()}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=catalog.CatalogImport.confirm.state),clear=AsyncMock(side_effect=clear))
    query=SimpleNamespace(data='ci:save:valid',from_user=SimpleNamespace(id=502),answer=AsyncMock(),message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(catalog.import_save(query,state))
    assert 'экземпляров: 2' in query.message.answer.call_args.args[0]


def test_catalog_search_includes_asset_identifier(monkeypatch):
    monkeypatch.setattr(catalog, 'staff_allows', lambda *_: True)
    asset=SimpleNamespace(id=987,inventory_number='ASSET',asset_inventory_code='',serial_number='',storage_location='')
    article=SimpleNamespace(id=11,sku='SKU',name='Камера',kind='',brand='',key_spec='',description='',equipment=[asset])
    monkeypatch.setattr(catalog,'list_articles',lambda:[article])
    catalog._queries[503]='987'
    message=SimpleNamespace(answer=AsyncMock())
    asyncio.run(catalog.catalog_list(message,503,0))
    assert 'Найдено моделей: 1' in message.answer.call_args.args[0]


def test_dependency_save_rejects_stale_confirmation(monkeypatch):
    monkeypatch.setattr(catalog, 'private', lambda _: True)
    monkeypatch.setattr(catalog, 'staff_allows', lambda *_: True)
    save=AsyncMock(); monkeypatch.setattr(catalog,'save_dependency',save)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'nonce':'new'}),get_state=AsyncMock(return_value=catalog.CatalogDependency.confirm.state))
    query=SimpleNamespace(data='cd:save:old',from_user=SimpleNamespace(id=504),answer=AsyncMock())
    asyncio.run(catalog.dependency_save(query,state))
    save.assert_not_called(); assert query.answer.call_args.kwargs['show_alert']


def test_editor_preserves_unmodified_article_values():
    before={'sku':'OLD','name':'Camera','kind':'camera','brand':'Canon','key_spec':'','description':'описание','composition':'Крышка','category':'generic','inspection_profile':'generic','buffer_hours':24,'image_url':'','is_active':True}
    result=catalog.editor_payload('article',before,{'name':'Новая модель'})
    assert result['name']=='Новая модель'
    assert result['sku']=='OLD' and result['composition']=='Крышка' and result['active'] is True


def test_editor_asset_nullable_values_and_limits():
    import pytest
    base={'article_id':1,'serial_number':'S','asset_inventory_code':'A','storage_location':'A1','condition':'available','health_percent':80,'charge_percent':90}
    result=catalog.editor_payload('equipment',base,{'serial':'','health':''})
    assert result['serial']=='' and result['health'] is None and result['charge']==90
    with pytest.raises(ValueError): catalog.editor_payload('equipment',base,{'health':'101'})


def test_editor_input_rejects_unknown_or_repeated_field():
    import pytest
    with pytest.raises(ValueError): catalog.parse_editor_values('name=A\nname=B',catalog.ARTICLE_FIELDS)
    with pytest.raises(ValueError): catalog.parse_editor_values('irrelevant=value',catalog.ARTICLE_FIELDS)


def test_editor_save_checks_nonce_and_role(monkeypatch):
    from app import rental
    monkeypatch.setattr(catalog,'private',lambda _:True)
    monkeypatch.setattr(catalog,'staff_allows',lambda *_:True)
    save=AsyncMock();monkeypatch.setattr(rental,'save_article',save)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'editor_nonce':'new'}),get_state=AsyncMock(return_value=catalog.CatalogEditor.confirm.state))
    query=SimpleNamespace(data='ce:save:old',from_user=SimpleNamespace(id=606),answer=AsyncMock())
    asyncio.run(catalog.editor_action(query,state))
    save.assert_not_called();assert query.answer.call_args.kwargs['show_alert']
