from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Booking, BookingAsset, BookingLine, Equipment, Session, StaffRole
from app.miniapp_server import app
from app.rental import AvailabilitySnapshot, _reserved_quantity, availability, create_booking, now, transition
from app.roadmap import external_schedule, save_external_block, release_external_block
from tests.test_integration import article_with_assets
from tests.test_miniapp import configure, signed_init_data


def test_overlapping_external_notes_count_the_same_asset_once(monkeypatch):
    configure(monkeypatch)
    article_id = article_with_assets('EXTERNAL-UNION',3)
    with Session() as session:
        asset = session.scalar(select(Equipment.id).where(Equipment.article_id==article_id))
    start=now()+timedelta(days=4); end=start+timedelta(hours=4)
    first=save_external_block(asset,start,end,'Съёмка',100)
    second=save_external_block(asset,start+timedelta(hours=1),end+timedelta(hours=1),'Продление',100,True)
    assert len(second['warnings'])==1
    assert next(item for item in availability(start,end) if item['id']==article_id)['available_quantity']==2
    with Session() as session:
        assert _reserved_quantity(session,article_id,start,end)==1
        assert AvailabilitySnapshot(session,[article_id],start,end).peak(article_id,start,end)==1
    release_external_block(first,100)
    assert len(external_schedule(asset))==1


def test_calendar_warns_about_booking_without_refusing_to_save_or_exposing_pii(monkeypatch):
    configure(monkeypatch)
    article_id=article_with_assets('EXTERNAL-BOOKING',1)
    with Session() as session:
        asset=session.scalar(select(Equipment.id).where(Equipment.article_id==article_id))
    start=now()+timedelta(days=4);end=start+timedelta(hours=2)
    booking_id=create_booking(42,'PRIVATE CUSTOMER','PRIVATE CONTACT',start,end,[{'article_id':article_id,'quantity':1}])
    transition(booking_id,'confirmed',100)
    headers=lambda uid:{'X-Telegram-Init-Data':signed_init_data(uid)}
    # Avoid actual Telegram delivery from application lifecycle in this API test.
    from unittest.mock import AsyncMock
    monkeypatch.setattr('app.miniapp_server.retry_pending_notifications',AsyncMock())
    with Session.begin() as session:
        session.get(StaffRole,200).role='operator'
    with TestClient(app) as client:
        url=f'/api/miniapp/admin/catalog/equipment/{asset}'
        assert client.get(url+'/schedule',headers=headers(42)).status_code==403
        assert client.get(url+'/schedule',headers=headers(200)).status_code==403
        response=client.get(url+'/schedule',headers=headers(100))
        assert response.status_code==200
        assert response.json()['items'][0]['kind']=='booking'
        assert 'PRIVATE' not in response.text
        body={'start':start.isoformat(),'end':end.isoformat(),'reason':'Вне сервиса'}
        result=client.post(url+'/blocks',headers=headers(100),json=body)
        assert result.status_code==200 and result.json()['id']
        assert len(result.json()['warnings'])==1
        assert result.json()['warnings'][0]['kind']=='booking'
        # Touching endpoints do not overlap.
        body.update(start=end.isoformat(),end=(end+timedelta(hours=1)).isoformat())
        result=client.post(url+'/blocks',headers=headers(100),json=body)
        assert result.status_code==200 and not result.json()['warnings']


def test_assigned_overdue_asset_warns_until_returned_without_marking_other_units(monkeypatch):
    configure(monkeypatch)
    article_id=article_with_assets('EXTERNAL-OVERDUE',2)
    with Session.begin() as session:
        assets=list(session.scalars(select(Equipment.id).where(Equipment.article_id==article_id).order_by(Equipment.id)))
        booking=Booking(customer_id=42,customer_name='PRIVATE',customer_contact='PRIVATE',status='issued',
                        starts_at=now()-timedelta(days=3),ends_at=now()-timedelta(days=1))
        session.add(booking);session.flush()
        line=BookingLine(booking_id=booking.id,article_id=article_id,quantity=1,hourly_rate=0)
        session.add(line);session.flush()
        session.add(BookingAsset(booking_id=booking.id,equipment_id=assets[0],booking_line_id=line.id))
    occupied=external_schedule(assets[0])
    assert len(occupied)==1 and occupied[0]['end'] is None
    assert occupied[0]['reason']=='Оборудование ещё не возвращено'
    assert external_schedule(assets[1])==[]
