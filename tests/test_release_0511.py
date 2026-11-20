import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.customer_next import next_actions, pending_ready, acknowledge_ready, public_features, save_settings
from app.db import Session, HandoverSettings, BookingEventRecipient, BookingEvent
from app.rental import transition, get_booking, Conflict
from app.handover import customer_attest, handover_state
from app.inventory import save_feature
from app.miniapp_server import app
from tests.test_completion_workflows import ready_booking
from tests.test_miniapp import signed_init_data


def headers(uid): return {'X-Telegram-Init-Data':signed_init_data(uid)}


def test_ready_invitation_is_non_destructive_owned_acknowledged_and_stale_safe(monkeypatch):
    booking_id=ready_booking(monkeypatch)
    transition(booking_id,'ready',100)
    one=pending_ready(42)
    assert len(one)==1 and pending_ready(42)==one
    assert pending_ready(43)==[]
    from app.booking_events import claim_notices
    claim_notices(42)
    assert pending_ready(42)==one, 'ordinary toast claiming must not consume ready invitation'
    with TestClient(app) as client:
        event=one[0]['event_id']
        assert client.post(f'/api/miniapp/notifications/{event}/ack',headers=headers(43)).status_code==422
        assert pending_ready(42)==one
        assert client.post(f'/api/miniapp/notifications/{event}/ack',headers=headers(42)).status_code==200
        assert client.post(f'/api/miniapp/notifications/{event}/ack',headers=headers(42)).status_code==200
        assert pending_ready(42)==[]
        assert client.get(f'/api/miniapp/bookings/{booking_id}',headers=headers(43)).status_code==404
    transition(booking_id,'issued',100)
    assert pending_ready(42)==[]
    assert next_actions(42)[0]['action']=='return'
    assert next_actions(43)==[]


def test_issue_requires_no_customer_received_and_return_checks_issue_cycle(monkeypatch):
    booking_id=ready_booking(monkeypatch,partial=True)
    transition(booking_id,'ready',100);transition(booking_id,'issued',100)
    assert not handover_state(booking_id).get('received_at')
    with TestClient(app) as client:
        path=f'/api/miniapp/bookings/{booking_id}/attest'
        assert client.post(path,headers=headers(42),json={'action':'received'}).status_code==409
        assert client.post(path,headers=headers(42),json={'action':'returning','issued_at':'old-cycle'}).status_code==409
        issued=handover_state(booking_id)['issued_at']
        assert client.post(path,headers=headers(42),json={'action':'returning','issued_at':issued}).status_code==200
        assert client.post(path,headers=headers(42),json={'action':'returning','issued_at':issued}).status_code==200
        assert client.post(path,headers=headers(43),json={'action':'returning'}).status_code in {409,422}
    assert get_booking(booking_id).status=='return_inspection'
    assert next_actions(42)[0]['action']=='open'


def test_settings_are_admin_only_and_features_remain_snapshot(monkeypatch):
    booking_id=ready_booking(monkeypatch)
    asset=get_booking(booking_id).assets[0].equipment_id
    feature=save_feature(asset,'Известная царапина',100)
    assert public_features(booking_id)[0]['features'][0]['description']=='Известная царапина'
    with TestClient(app) as client:
        url='/api/miniapp/admin/handover-settings'
        assert client.put(url,headers=headers(200),json={'pickup_location':'Недопустимо'}).status_code==403
        assert client.put(url,headers=headers(100),json={'pickup_location':'Тестовая выдача','pickup_instructions':'Приходите в своё время'}).status_code==200
        assert client.put(url,headers=headers(100),json={'pickup_location':'x'*501}).status_code==422
        transition(booking_id,'ready',100)
        result=client.get('/api/miniapp/customer/next-actions',headers=headers(42)).json()['items'][0]
        assert result['pickup_location']=='Тестовая выдача'
        assert 'МСК' in result['description']
        payload=client.get(f'/api/miniapp/bookings/{booking_id}',headers=headers(42)).json()
        assert 'serial' not in str(payload['equipment_details']) and 'code' not in str(payload['equipment_details'])
    save_feature(asset,'Изменено позднее',100,feature)
    assert public_features(booking_id)[0]['features'][0]['description']=='Известная царапина'


def test_return_chat_requires_current_confirmation_and_no_received_button(monkeypatch):
    from app import chat_workflows as cw
    from tests.test_chat_customer_integration import MemoryState
    monkeypatch.setattr(cw,'private',lambda _:True)
    booking_id=ready_booking(monkeypatch);transition(booking_id,'ready',100);transition(booking_id,'issued',100)
    state=MemoryState();message=SimpleNamespace(answer=AsyncMock(),edit_text=AsyncMock())
    query=SimpleNamespace(data=f'cw:askattest:{booking_id}:returning',from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=message)
    asyncio.run(cw.customer_action(query,state))
    assert get_booking(booking_id).status=='issued'
    nonce=state.data['return_nonce']
    query.data=f'cw:returnconfirm:{booking_id}:wrong';asyncio.run(cw.customer_action(query,state))
    assert get_booking(booking_id).status=='issued'
    query.data=f'cw:returnconfirm:{booking_id}:{nonce}';asyncio.run(cw.customer_action(query,state))
    assert get_booking(booking_id).status=='return_inspection'
    asyncio.run(cw.show_customer_booking(message,booking_id,42))
    labels=[b.text for row in message.answer.call_args.kwargs['reply_markup'].inline_keyboard for b in row]
    assert 'Подтвердить получение' not in labels and 'Сдать оборудование' not in labels
    message.chat=SimpleNamespace(type='private')
    query.data=f'cw:support:{booking_id}';asyncio.run(cw.customer_action(query,state))
    from app.bot import Support
    assert state.state==Support.message.state


def test_a_new_ready_cycle_has_its_own_invitation(monkeypatch):
    from app.rental import return_for_rework
    booking_id=ready_booking(monkeypatch);transition(booking_id,'ready',100)
    old=pending_ready(42)[0]['event_id'];acknowledge_ready(42,old)
    return_for_rework(booking_id,'preparing','Повторить подготовку',100)
    assert pending_ready(42)==[]
    transition(booking_id,'ready',100)
    current=pending_ready(42)[0]['event_id'];assert current!=old
    acknowledge_ready(42,old)
    assert pending_ready(42)[0]['event_id']==current


def test_ready_push_has_actionable_buttons_and_retries_do_not_duplicate(monkeypatch):
    from app.db import NotificationDelivery
    from app.notification_outbox import deliver_notification
    from app import bot
    class FakeBot:
        def __init__(self): self.send_message=AsyncMock(return_value=SimpleNamespace(message_id=123))
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
    fake=FakeBot();monkeypatch.setattr(bot,'make_bot',lambda _:fake)
    booking_id=ready_booking(monkeypatch);transition(booking_id,'ready',100)
    with Session() as session:
        delivery=session.scalar(select(NotificationDelivery.id).join(BookingEvent,NotificationDelivery.event_id==BookingEvent.id).where(
            NotificationDelivery.booking_id==booking_id,NotificationDelivery.recipient_id==42,
            NotificationDelivery.delivery_kind=='push',BookingEvent.actions.contains(['ready'])))
    assert asyncio.run(deliver_notification(delivery))
    assert asyncio.run(deliver_notification(delivery))
    assert fake.send_message.await_count==1
    args=fake.send_message.call_args
    assert 'готово к выдаче' in args.args[1] and 'МСК' in args.args[1]
    assert args.kwargs['reply_markup'].inline_keyboard[0][0].text=='Открыть заявку'
    with Session.begin() as session: session.get(NotificationDelivery,delivery).sent_at=None
    transition(booking_id,'issued',100)
    assert not asyncio.run(deliver_notification(delivery))
    assert fake.send_message.await_count==1, 'stale ready pushes must not invite after issue'


def test_start_menu_exposes_return_for_owned_issued_booking(monkeypatch):
    from app import bot
    from tests.test_chat_customer_integration import MemoryState
    booking_id=ready_booking(monkeypatch);transition(booking_id,'ready',100);transition(booking_id,'issued',100)
    message=SimpleNamespace(chat=SimpleNamespace(type='private'),from_user=SimpleNamespace(id=42),answer=AsyncMock())
    asyncio.run(bot.start(message,MemoryState()))
    assert any(button.text=='Сдать оборудование' for row in bot.main_keyboard().keyboard for button in row)
    buttons=message.answer.call_args.kwargs['reply_markup'].inline_keyboard
    assert buttons[0][0].callback_data==f'cw:askattest:{booking_id}:returning'
