from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Audit, Booking, BookingEvent, BookingHandover, Session
from app.handover import customer_attest, handover_state
from app.rental import (Conflict, get_booking, record_inspection, return_for_rework,
                        start_return_without_customer, transition)
from tests.test_completion_workflows import ready_booking
from tests.test_miniapp import signed_init_data


def issued_booking(monkeypatch):
    booking_id = ready_booking(monkeypatch)
    transition(booking_id, 'ready', 100)
    transition(booking_id, 'issued', 100)
    return booking_id


def test_operator_return_preserves_customer_attestation_and_requires_checks(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    assert start_return_without_customer(booking_id, 100, 'Приёмщик') == 'return_inspection'
    data = handover_state(booking_id)
    assert not data.get('returning_at')
    assert data['operator_return']['actor_id'] == 100
    assert data['operator_return']['actor_name'] == 'Приёмщик'
    started = get_booking(booking_id).inspection_cycle_started_at
    with Session() as session:
        events = len(session.scalars(select(BookingEvent).where(BookingEvent.booking_id == booking_id)).all())
    start_return_without_customer(booking_id, 100)
    assert get_booking(booking_id).inspection_cycle_started_at == started
    with Session() as session:
        assert len(session.scalars(select(BookingEvent).where(BookingEvent.booking_id == booking_id)).all()) == events
    with pytest.raises(Conflict, match='Проверьте каждый'):
        transition(booking_id, 'returned', 100)
    for asset in get_booking(booking_id).assets:
        record_inspection(booking_id, asset.equipment_id, 'check_in', 'pass', {}, '', 100)
    assert transition(booking_id, 'returned', 100) == 'returned'
    assert get_booking(booking_id).returned_at is not None
    assert get_booking(booking_id).assignee_id is None
    with Session() as session:
        assert len(session.scalars(select(Audit).where(Audit.booking_id == booking_id,
                   Audit.action == 'operator_return_confirmed')).all()) == 1


def test_operator_return_rejects_foreign_operator_and_stale_states(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    with pytest.raises(PermissionError):
        start_return_without_customer(booking_id, 42)
    with pytest.raises(Conflict):
        start_return_without_customer(booking_id, 200)
    with Session.begin() as session:
        session.get(BookingHandover, booking_id).data = {'recipient_id': 43}
    with pytest.raises(Conflict, match='Получатель'):
        start_return_without_customer(booking_id, 100)
    with Session.begin() as session:
        session.delete(session.get(BookingHandover, booking_id))
    with pytest.raises(Conflict, match='старой заявки'):
        start_return_without_customer(booking_id, 100)
    with Session.begin() as session:
        session.get(Booking, booking_id).status = 'cancelled'
    with pytest.raises(Conflict):
        start_return_without_customer(booking_id, 100)


def test_operator_and_customer_return_race_opens_one_cycle(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = [pool.submit(start_return_without_customer, booking_id, 100),
                   pool.submit(customer_attest, booking_id, 42, 'returning'),
                   pool.submit(start_return_without_customer, booking_id, 100)]
        for result in results:
            result.result()
    assert get_booking(booking_id).status == 'return_inspection'
    with Session() as session:
        assert len(session.scalars(select(Audit).where(Audit.booking_id == booking_id,
                   Audit.action == 'return_inspection')).all()) == 1


def test_rework_clears_operator_confirmation(monkeypatch):
    booking_id = issued_booking(monkeypatch)
    start_return_without_customer(booking_id, 100)
    return_for_rework(booking_id, 'issued', 'Возврат ещё не состоялся', 100)
    assert not handover_state(booking_id).get('operator_return')
    with pytest.raises(Conflict):
        transition(booking_id, 'return_inspection', 100)


def test_return_without_customer_api_allows_operator_and_rejects_customer(monkeypatch):
    from app.miniapp_server import app
    booking_id = issued_booking(monkeypatch)
    with Session.begin() as session:
        session.get(Booking, booking_id).assignee_id = 200
    url = f'/api/miniapp/admin/bookings/{booking_id}/return-without-customer'
    with TestClient(app) as client:
        assert client.post(url, headers={'X-Telegram-Init-Data': signed_init_data(42)}).status_code == 403
        response = client.post(url, headers={'X-Telegram-Init-Data': signed_init_data(200)})
        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'return_inspection'
        assert not response.json()['handover'].get('returning_at')
        assert client.post(url, headers={'X-Telegram-Init-Data': signed_init_data(200)}).status_code == 200


def test_chat_confirms_before_starting_return(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app import chat_workflows as cw
    booking_id = issued_booking(monkeypatch)
    monkeypatch.setattr(cw, 'private', lambda event: True)
    monkeypatch.setattr(cw, 'show_staff_booking', AsyncMock())
    query = SimpleNamespace(data=f'sw:returnask:{booking_id}',
        from_user=SimpleNamespace(id=100, full_name='Приёмщик'),
        answer=AsyncMock(), message=SimpleNamespace(answer=AsyncMock()))
    asyncio.run(cw.staff_action(query, None))
    assert get_booking(booking_id).status == 'issued'
    assert 'фактически возвращено' in query.message.answer.call_args.args[0]
    query.data = f'sw:returndo:{booking_id}'
    asyncio.run(cw.staff_action(query, None))
    assert get_booking(booking_id).status == 'return_inspection'
    assert not handover_state(booking_id).get('returning_at')
