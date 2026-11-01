from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import importlib.util
import threading
import time
from uuid import uuid4

import pytest
from sqlalchemy import select, text

from app.db import (Booking, BookingChange, Equipment, NotificationDelivery, Session, StaffNavigation, engine)
from app.rental import Conflict, availability, create_booking, get_booking, now, transition
from app.booking_changes import change_view, decline_request
from app.roadmap import save_external_block, release_external_block, save_staff_section, queue_optional_reminders
from tests.test_miniapp import configure
from tests.test_integration import article_with_assets
from tests.test_operation_lease import pending_booking

MOSCOW=ZoneInfo("Europe/Moscow")


def test_working_calendar_validates_planned_and_actual_operations(monkeypatch):
    from app.schedule import validate_planned_slot, validate_operation_window
    import app.schedule as schedule
    monkeypatch.setenv("ENFORCE_HANDOVER_SCHEDULE","true")
    for stamp in ("2026-11-02T09:00","2026-11-02T17:30","2026-07-01T08:30","2026-07-01T17:00"):
        validate_planned_slot(datetime.fromisoformat(stamp).replace(tzinfo=MOSCOW))
    for stamp in ("2026-11-01T10:00","2026-11-04T10:00","2026-11-02T08:59","2026-11-02T17:31","2026-07-01T17:01"):
        moment=datetime.fromisoformat(stamp).replace(tzinfo=MOSCOW)
        with pytest.raises(ValueError): validate_planned_slot(moment)
        monkeypatch.setattr(schedule,"current_time",lambda:moment)
        with pytest.raises(Conflict): validate_operation_window()


def test_external_use_competes_with_confirmations_and_releases_immediately(monkeypatch):
    configure(monkeypatch)
    article=article_with_assets("EXTERNAL",1)
    start=now()+timedelta(days=5); end=start+timedelta(hours=2)
    booking_id=create_booking(42,"Клиент","@client",start,end,[{"article_id":article,"quantity":1}])
    with Session() as session: asset=session.scalar(select(Equipment.id).where(Equipment.article_id==article))
    block=save_external_block(asset,start,end,"Съёмка медиацентра",100)
    item=next(row for row in availability(start,end) if row["id"]==article)
    assert item["available_quantity"]==0 and item["unavailability"][0]["reason"]=="Съёмка медиацентра"
    with pytest.raises(Conflict): transition(booking_id,"confirmed",100)
    with pytest.raises(Conflict): save_external_block(asset,start,end,"Другая работа",100)
    release_external_block(block,100)
    assert transition(booking_id,"confirmed",100)=="confirmed"
    with pytest.raises(Conflict): save_external_block(asset,start,end,"Слишком поздно",100)


def test_concurrent_external_use_and_confirmation_cannot_both_win(monkeypatch):
    configure(monkeypatch)
    booking_id=pending_booking(); booking=get_booking(booking_id)
    with Session() as session: asset=session.scalar(select(Equipment.id).where(Equipment.article_id==booking.lines[0].article_id))
    def reserve(kind):
        try:
            if kind=="block": save_external_block(asset,booking.starts_at,booking.ends_at,"Внешняя работа",100)
            else: transition(booking_id,"confirmed",100)
            return "ok"
        except Conflict: return "conflict"
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reserve,["block","booking"]))==["conflict","ok"]


def test_decline_reason_and_notification_are_encrypted(monkeypatch):
    configure(monkeypatch); booking_id=pending_booking()
    decline_request(booking_id,100,"Нет согласования с руководителем")
    assert get_booking(booking_id).status=="cancelled"
    assert change_view(booking_id,42)["comment"]=="Нет согласования с руководителем"
    assert "comment" not in change_view(booking_id,200)
    from app.notification_outbox import delivery_message
    with Session() as session:
        rows=session.scalars(select(NotificationDelivery).where(NotificationDelivery.booking_id==booking_id,NotificationDelivery.event=="booking_update")).all()
        assert rows and all("Нет согласования" not in delivery_message(row) for row in rows)
        assert any("Заявка отклонена" in delivery_message(row) for row in rows)


def test_reminders_are_optional_durable_and_cancelled_when_disabled(monkeypatch):
    configure(monkeypatch); booking_id=pending_booking(); transition(booking_id,"confirmed",100)
    booking=get_booking(booking_id)
    moment=booking.starts_at-timedelta(hours=23)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(queue_optional_reminders,[moment,moment]))==1
    assert queue_optional_reminders(booking.starts_at-timedelta(hours=1))==1
    assert queue_optional_reminders(booking.starts_at-timedelta(minutes=30))==0
    from app.client_profile import set_reminders_enabled
    set_reminders_enabled(42,False)
    with Session() as session:
        rows=session.scalars(select(NotificationDelivery).where(NotificationDelivery.booking_id==booking_id,NotificationDelivery.event.like("optional_reminder_%"))).all()
        assert len(rows)==2 and all(row.cancelled_at is not None for row in rows)


def test_staff_navigation_is_private_and_survives_sessions(monkeypatch):
    configure(monkeypatch)
    save_staff_section(100,"catalog")
    save_staff_section(200,"orders")
    with Session() as session:
        assert session.get(StaffNavigation,100).section=="catalog"
        assert session.get(StaffNavigation,200).section=="orders"
    with pytest.raises(PermissionError): save_staff_section(42,"catalog")
    with pytest.raises(PermissionError): save_staff_section(200,"hidden_tests")


def test_online_number_backfill_is_ordered_idempotent_with_concurrent_writes():
    from app.number_backfill import backfill_request_numbers
    schema="number_qa_"+uuid4().hex
    stop=threading.Event(); failures=[]; latencies=[]
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET search_path TO "{schema}"'))
        connection.exec_driver_sql("CREATE TABLE bookings (id SERIAL PRIMARY KEY,customer_id BIGINT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),human_number VARCHAR(32) UNIQUE)")
        connection.exec_driver_sql("CREATE TABLE audit (id SERIAL PRIMARY KEY,booking_id INTEGER,actor_id BIGINT,action VARCHAR(40))")
        connection.exec_driver_sql("CREATE INDEX audit_booking_action_idx ON audit (booking_id,action)")
        connection.exec_driver_sql("INSERT INTO bookings (customer_id,created_at) SELECT 42,'2026-01-10'::timestamptz+(20000-n)*interval '1 second' FROM generate_series(1,20000) n")
        def writer():
            try:
                with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as other:
                    other.execute(text(f'SET search_path TO "{schema}"'))
                    try:
                        while not stop.is_set():
                            started=time.monotonic()
                            other.exec_driver_sql("INSERT INTO bookings (customer_id) VALUES (43)")
                            latencies.append(time.monotonic()-started)
                            time.sleep(.01)
                    finally:
                        other.exec_driver_sql("SET search_path TO public")
            except Exception as exc: failures.append(type(exc).__name__)
        thread=threading.Thread(target=writer);thread.start()
        try:
            assert backfill_request_numbers(connection)>=20000
            stop.set();thread.join(timeout=10)
            assert not thread.is_alive() and not failures and latencies
            assert connection.exec_driver_sql("SELECT count(*) FROM bookings WHERE human_number IS NULL").scalar_one()==0
            values=connection.exec_driver_sql("SELECT substring(human_number FROM 5)::integer FROM bookings WHERE customer_id=42 ORDER BY created_at,id").scalars().all()
            assert values==sorted(values) and len(set(values))==20000
            before=connection.exec_driver_sql("SELECT id,human_number FROM bookings ORDER BY id").all()
            assert backfill_request_numbers(connection)==0
            assert connection.exec_driver_sql("SELECT id,human_number FROM bookings ORDER BY id").all()==before
            assert connection.exec_driver_sql("SELECT count(*)=count(DISTINCT human_number) FROM bookings").scalar_one()
        finally:
            stop.set();thread.join(timeout=10)
            connection.execute(text('SET search_path TO public'))
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
