from datetime import timedelta
from sqlalchemy import event, select

from app.db import Booking, BookingHandover, BookingLine, Equipment, EquipmentBlock, Session, engine
from app.rental import AvailabilitySnapshot, _reserved_quantity, availability, now
from tests.test_integration import article_with_assets


def test_batched_availability_matches_reservation_rules():
    camera = article_with_assets('BATCH-CAMERA', 3)
    lens = article_with_assets('BATCH-LENS', 2)
    start = now() + timedelta(days=3)
    end = start + timedelta(hours=4)
    with Session.begin() as session:
        booking = Booking(customer_id=42, customer_name='QA', customer_contact='@qa', status='confirmed', starts_at=start, ends_at=end)
        session.add(booking); session.flush()
        line = BookingLine(booking_id=booking.id, article_id=camera, quantity=2, hourly_rate=0)
        session.add(line); session.flush()
        session.add(BookingHandover(booking_id=booking.id, data={'exceptions':[{'line_id':line.id, 'reason':'replacement', 'replacement_article_id':lens}]}))
        overdue = Booking(customer_id=43, customer_name='QA', customer_contact='@qa', status='issued', starts_at=now()-timedelta(days=3), ends_at=now()-timedelta(days=1))
        session.add(overdue); session.flush()
        session.add(BookingLine(booking_id=overdue.id, article_id=camera, quantity=1, hourly_rate=0))
        equipment_id = session.scalar(select(Equipment.id).where(Equipment.article_id == lens).limit(1))
        session.add(EquipmentBlock(equipment_id=equipment_id, starts_at=start+timedelta(hours=1), ends_at=end, reason='QA', actor_id=100))
    with Session() as session:
        snapshot = AvailabilitySnapshot(session, [camera, lens], start, end + timedelta(days=1))
        for article_id in (camera, lens):
            assert snapshot.peak(article_id, start, end) == _reserved_quantity(session, article_id, start, end)
        assert snapshot.peak(camera, start, end) == 1
        assert snapshot.peak(lens, start, end) == 2
    result = {item['id']:item for item in availability(start, end)}
    assert result[camera]['available_quantity'] == 2
    assert result[lens]['available_quantity'] == 0


def test_availability_query_count_does_not_grow_per_article():
    start = now() + timedelta(days=3)
    end = start + timedelta(hours=2)
    article_with_assets('BATCH-ONE', 1)
    queries = []
    def count_query(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().lower().startswith('select'):
            queries.append(statement)
    event.listen(engine, 'before_cursor_execute', count_query)
    try:
        availability(start, end)
        single = len(queries)
        event.remove(engine, 'before_cursor_execute', count_query)
        for index in range(5):
            article_with_assets(f'BATCH-MORE-{index}', 1)
        queries.clear()
        event.listen(engine, 'before_cursor_execute', count_query)
        availability(start, end)
        assert len(queries) == single
        assert single <= 5
    finally:
        event.remove(engine, 'before_cursor_execute', count_query)


def test_nearest_period_checks_the_entire_selection_and_quantity(monkeypatch):
    from app.rental import nearest_available_period
    camera = article_with_assets('NEAR-CAMERA', 2)
    lens = article_with_assets('NEAR-LENS', 1)
    start = (now() + timedelta(days=3)).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=1)
    with Session.begin() as session:
        for article_id, left, right in ((camera, start, start + timedelta(hours=1)),
                                         (lens, start + timedelta(hours=1), start + timedelta(hours=3))):
            booking = Booking(customer_id=42, customer_name='QA', customer_contact='@qa', status='confirmed', starts_at=left, ends_at=right)
            session.add(booking); session.flush()
            session.add(BookingLine(booking_id=booking.id, article_id=article_id, quantity=1, hourly_rate=0))
    selection = [{'article_id':camera, 'quantity':2}, {'article_id':lens, 'quantity':1}]
    result = nearest_available_period(start, end, selection)
    assert result == {'start':(start+timedelta(hours=3)).isoformat(), 'end':(end+timedelta(hours=3)).isoformat()}
    assert nearest_available_period(start, end, [{'article_id':camera, 'quantity':3}]) is None
    assert nearest_available_period(start, end, [{'article_id':999999, 'quantity':1}]) is None


def test_nearest_period_respects_working_hours(monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from app.rental import nearest_available_period
    monkeypatch.setenv('ENFORCE_HANDOVER_SCHEDULE', 'true')
    camera = article_with_assets('NEAR-WORK', 1)
    local_day = (now() + timedelta(days=8)).astimezone(ZoneInfo('Europe/Moscow')).date()
    from app.schedule import is_working_day
    while not is_working_day(local_day) or not is_working_day(local_day + timedelta(days=1)):
        local_day += timedelta(days=1)
    start = datetime.combine(local_day, datetime.min.time(), tzinfo=ZoneInfo('Europe/Moscow')).replace(hour=9)
    end = start + timedelta(hours=1)
    with Session.begin() as session:
        booking = Booking(customer_id=42, customer_name='QA', customer_contact='@qa', status='confirmed', starts_at=start, ends_at=start.replace(hour=17, minute=30))
        session.add(booking); session.flush()
        session.add(BookingLine(booking_id=booking.id, article_id=camera, quantity=1, hourly_rate=0))
    result = nearest_available_period(start, end, [{'article_id':camera, 'quantity':1}])
    expected = start.replace(hour=17, minute=30).astimezone(__import__('datetime').timezone.utc)
    assert result['start'] == expected.isoformat()


def test_nearest_period_api_requires_authentication_and_validates_selection(monkeypatch):
    from fastapi.testclient import TestClient
    from app.miniapp_server import app
    from tests.test_miniapp import configure, signed_init_data
    configure(monkeypatch)
    camera = article_with_assets('NEAR-API', 1)
    start = (now() + timedelta(days=3)).replace(minute=0, second=0, microsecond=0)
    payload = {'start':start.isoformat(), 'end':(start+timedelta(hours=1)).isoformat(), 'lines':[{'article_id':camera, 'quantity':1}]}
    with TestClient(app) as client:
        assert client.post('/api/miniapp/availability/nearest', json=payload).status_code == 401
        headers = {'X-Telegram-Init-Data':signed_init_data(42)}
        result = client.post('/api/miniapp/availability/nearest', json=payload, headers=headers)
        assert result.status_code == 200 and result.json()['period']['start'] == start.isoformat()
        assert client.post('/api/miniapp/availability/nearest', json={**payload,'lines':[{'article_id':camera,'quantity':31}]}, headers=headers).status_code == 422


def test_client_catalog_pages_keep_selected_items_and_search_public_fields(monkeypatch):
    from fastapi.testclient import TestClient
    from app.db import Article
    from app.miniapp_server import app
    from tests.test_miniapp import configure
    configure(monkeypatch)
    ids=[]
    with Session.begin() as session:
        for index in range(25):
            article=Article(sku=f'CLIENT-{index:02}', name=f'Камера {index:02}', category='camera')
            session.add(article); session.flush(); ids.append(article.id)
            session.add(Equipment(inventory_number=f'CLIENT-{index:02}',name=article.name,description='',hourly_rate=0,condition='available',article_id=article.id,serial_number='PRIVATE-SERIAL' if index==24 else None))
    start=now()+timedelta(days=3);end=start+timedelta(hours=1)
    params={'start':start.isoformat(),'end':end.isoformat(),'page':0,'page_size':10,'selected':ids[-1]}
    with TestClient(app) as client:
        catalog=client.get('/api/miniapp/catalog',params={'page':0,'page_size':10,'selected':ids[-1]})
        assert catalog.status_code == 200
        catalog_data = catalog.json()
        assert catalog_data['total'] == 25 and len(catalog_data['items']) == 10
        assert catalog_data['selected_items'][0]['id'] == ids[-1]
        assert 'available_quantity' not in catalog_data['selected_items'][0]
        assert client.get('/api/miniapp/catalog',params={'q':'PRIVATE-SERIAL'}).json()['total'] == 0
        assert client.get('/api/miniapp/catalog',params=[('selected', str(i)) for i in range(1,32)]).status_code == 422
        first=client.get('/api/miniapp/availability',params=params)
        assert first.status_code==200
        result=first.json()
        assert result['total']==25 and len(result['all_items'])==10
        assert result['selected_items'][0]['id']==ids[-1] and result['selected_items'][0]['available_quantity']==1
        assert ids[-1] not in [item['id'] for item in result['all_items']]
        found=client.get('/api/miniapp/availability',params={**params,'q':'Камера 24'}).json()
        assert found['total']==1 and found['all_items'][0]['id']==ids[-1]
        assert client.get('/api/miniapp/availability',params={**params,'q':'PRIVATE-SERIAL'}).json()['total']==0
        too_many=[('start',start.isoformat()),('end',end.isoformat()),('page','0')]+[('selected',str(i)) for i in range(1,32)]
        assert client.get('/api/miniapp/availability',params=too_many).status_code==422
        legacy=client.get('/api/miniapp/availability',params={'start':start.isoformat(),'end':end.isoformat()}).json()
        assert len(legacy['all_items'])==25 and legacy['page'] is None
