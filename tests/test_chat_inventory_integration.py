import asyncio
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app import chat_inventory as ui
from app.inventory import save_owner, save_feature, inventory_details
from app.rental import save_article, save_equipment, Conflict
from app.roadmap import external_blocks


class MemoryState:
    def __init__(self,data): self.data=dict(data);self.state=ui.InventoryEdit.confirm.state
    async def get_data(self): return dict(self.data)
    async def get_state(self): return self.state
    async def clear(self): self.data={};self.state=None


def fixture_asset():
    article=save_article('INV-CHAT','Камера','',0,actor_id=100)
    return save_equipment('','','',0,'available',article_id=article)


def test_owner_update_rejects_stale_snapshot():
    asset=fixture_asset()
    save_owner(asset,'Первый','контакт',100)
    stale=ui.owner_snapshot(asset)
    save_owner(asset,'Второй','',100)
    with pytest.raises(Conflict,match='изменились'): save_owner(asset,'Устаревший','',100,stale)
    assert inventory_details(asset)['owner']=='Второй'


def test_feature_update_rejects_stale_snapshot():
    asset=fixture_asset();feature=save_feature(asset,'Царапина',100)
    save_feature(asset,'Другая царапина',100,feature)
    with pytest.raises(Conflict,match='изменилась'): save_feature(asset,'Старый текст',100,feature,False,'catalog','Царапина')
    assert inventory_details(asset)['features'][0]['description']=='Другая царапина'


def test_chat_block_creation_and_release(monkeypatch):
    monkeypatch.setattr(ui,'inventory_menu',AsyncMock())
    asset=fixture_asset();start=datetime.now(timezone.utc)+timedelta(days=3);end=start+timedelta(days=1)
    state=MemoryState({'operation':'block','asset_id':asset,'inventory_nonce':'abc','values':{'start':start.isoformat(),'end':end.isoformat(),'reason':'Съёмка'}})
    query=SimpleNamespace(from_user=SimpleNamespace(id=100),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(ui.inventory_save(query,state,'abc'))
    blocks=external_blocks(asset);assert len(blocks)==1
    state=MemoryState({'operation':'block_release','asset_id':asset,'inventory_nonce':'xyz','block_id':blocks[0]['id']})
    asyncio.run(ui.inventory_save(query,state,'xyz'))
    assert external_blocks(asset)==[]
