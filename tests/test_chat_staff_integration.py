import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from app import chat_workflows as cw
from app.booking_changes import change_view
from app.db import BookingHandover, EquipmentFeature, Session
from app.rental import Conflict, get_booking, reassign_booking, transition
from tests.test_completion_workflows import ready_booking
from tests.test_miniapp import configure
from tests.test_operation_lease import pending_booking
from tests.workflow_helpers import returning


class MemoryState:
    def __init__(self,data): self.data=dict(data);self.state=cw.StaffWorkflow.confirm.state
    async def get_data(self): return dict(self.data)
    async def get_state(self): return self.state
    async def clear(self): self.data={};self.state=None


def query(actor=100):
    return SimpleNamespace(from_user=SimpleNamespace(id=actor,full_name='Сотрудник'),answer=AsyncMock(),message=SimpleNamespace())


def test_reassign_rejects_changed_responsible(monkeypatch):
    configure(monkeypatch);booking_id=pending_booking()
    reassign_booking(booking_id,100,200)
    with pytest.raises(Conflict,match='Ответственный изменился'):
        reassign_booking(booking_id,100,100,None,True)
    assert get_booking(booking_id).assignee_id==200


def test_chat_staff_fix_creates_existing_proposal(monkeypatch):
    configure(monkeypatch);monkeypatch.setattr(cw,'show_staff_booking',AsyncMock())
    booking_id=pending_booking();booking=get_booking(booking_id)
    state=MemoryState({'workflow_nonce':'n','workflow_operation':'fix','workflow_booking':booking_id,'workflow_before':cw.workflow_snapshot(booking),'workflow_comment':'Уточните сроки'})
    asyncio.run(cw.staff_workflow_save(query(),state,'n'))
    assert change_view(booking_id,42)['change_type']=='client_fix'
    assert get_booking(booking_id).status=='needs_changes'


def test_chat_return_finding_records_feature_once(monkeypatch):
    monkeypatch.setattr(cw,'show_staff_booking',AsyncMock())
    booking_id=ready_booking(monkeypatch);transition(booking_id,'ready',100)
    from app.handover import customer_attest
    customer_attest(booking_id,42,'received');transition(booking_id,'issued',100);returning(booking_id)
    asset_id=get_booking(booking_id).assets[0].equipment_id
    state=MemoryState({'workflow_nonce':'n','workflow_operation':'finding','workflow_booking':booking_id,'workflow_asset':asset_id,'workflow_kind':'existing','workflow_comment':'Прежняя царапина'})
    actor=query();asyncio.run(cw.staff_workflow_save(actor,state,'n'))
    with pytest.raises(Conflict):asyncio.run(cw.staff_workflow_save(actor,state,'n'))
    with Session() as session:
        features=session.scalars(select(EquipmentFeature).where(EquipmentFeature.equipment_id==asset_id)).all()
        assert len(features)==1 and features[0].description=='Прежняя царапина'
        assert len(session.get(BookingHandover,booking_id).data['findings'])==1
