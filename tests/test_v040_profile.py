from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.client_profile import complete_onboarding, mark_onboarding_shown
from app.db import Booking, ClientActivity, ClientProfile, Session
from app.rental import now
from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def headers(user_id):
    return {"X-Telegram-Init-Data": signed_init_data(user_id)}


def test_onboarding_once_concurrent_and_completion_idempotent():
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(mark_onboarding_shown, [42] * 8))
    assert sum(results) == 1
    complete_onboarding(42)
    complete_onboarding(42)
    with Session() as session:
        assert session.get(ClientProfile, 42).onboarding_shown_at
        actions = session.scalars(select(ClientActivity.action).where(ClientActivity.telegram_id == 42)).all()
        assert sorted(actions) == ["onboarding_completed", "onboarding_first_shown"]


def test_profile_entry_permissions_and_independent_onboarding(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/miniapp/profile").status_code == 401
        customer = client.get("/api/miniapp/profile", headers=headers(42)).json()
        operator = client.get("/api/miniapp/profile", headers=headers(100)).json()
        assert customer["start_screen"] == "booking" and operator["start_screen"] == "management"
        assert not customer["onboarding_seen"] and not operator["onboarding_seen"]
        assert client.post("/api/miniapp/operator/client-mode", headers=headers(42)).status_code == 403
        assert client.post("/api/miniapp/operator/client-mode", headers=headers(100)).status_code == 200
        assert client.post("/api/miniapp/onboarding/show", headers=headers(100)).json()["first_show"]
        assert not client.post("/api/miniapp/onboarding/show", headers=headers(100)).json()["first_show"]
        assert not client.get("/api/miniapp/profile", headers=headers(42)).json()["onboarding_seen"]
        assert client.post("/api/miniapp/onboarding/complete", headers=headers(100)).status_code == 200
        with Session() as session:
            actions = session.scalars(select(ClientActivity.action).where(ClientActivity.telegram_id == 100)).all()
            assert sorted(actions) == ["onboarding_completed", "onboarding_first_shown", "operator_client_mode"]


def test_reminder_preference_is_private_and_strict(monkeypatch):
    configure(monkeypatch)
    with TestClient(app) as client:
        url = "/api/miniapp/profile/reminders"
        assert client.put(url, json={"enabled": False}).status_code == 401
        assert client.put(url, headers=headers(42), json={"enabled": "false"}).status_code == 422
        for _ in range(2):
            assert client.put(url, headers=headers(42), json={"enabled": False}).json() == {"enabled": False}
        assert client.get("/api/miniapp/profile", headers=headers(42)).json()["reminders_enabled"] is False
        assert client.get("/api/miniapp/profile", headers=headers(43)).json()["reminders_enabled"] is True
        assert client.put(url, headers=headers(42), json={"enabled": True, "id": 43}).status_code == 422


def test_profile_history_is_paginated_filtered_and_customer_scoped(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        for index in range(14):
            session.add(Booking(customer_id=42, customer_name="Клиент", customer_contact="@qa",
                                starts_at=now(), ends_at=now() + timedelta(hours=1),
                                status="pending" if index < 12 else "returned"))
        session.add(Booking(customer_id=43, customer_name="Другой", customer_contact="@other",
                            starts_at=now(), ends_at=now() + timedelta(hours=1), status="pending"))
    with TestClient(app) as client:
        assert client.get("/api/miniapp/profile/history").status_code == 401
        first = client.get("/api/miniapp/profile/history?category=active&page=0", headers=headers(42)).json()
        second = client.get("/api/miniapp/profile/history?category=active&page=1", headers=headers(42)).json()
        completed = client.get("/api/miniapp/profile/history?category=completed", headers=headers(42)).json()
        assert first["total"] == 12 and len(first["items"]) == 10 and len(second["items"]) == 2
        assert len(completed["items"]) == 2 and all(x["status"] == "returned" for x in completed["items"])
        assert not ({x["id"] for x in first["items"]} & {x["id"] for x in second["items"]})
        assert client.get("/api/miniapp/profile/history?category=other", headers=headers(42)).status_code == 422


def test_search_accepts_full_numbers_and_only_four_digit_sequences(monkeypatch):
    configure(monkeypatch)
    with Session.begin() as session:
        for customer_id, number in ((42, "ТС260001"), (42, "ТС2610001"), (43, "ТС260002")):
            session.add(Booking(customer_id=customer_id, human_number=number, customer_name="QA", customer_contact="@qa",
                                starts_at=now(), ends_at=now() + timedelta(hours=1), status="pending"))
    with TestClient(app) as client:
        base = "/api/miniapp/profile/history?category=all&number="
        assert [row["human_number"] for row in client.get(base + "0001", headers=headers(42)).json()["items"]] == ["ТС260001"]
        assert [row["human_number"] for row in client.get(base + "ТС2610001", headers=headers(42)).json()["items"]] == ["ТС2610001"]
        assert client.get(base + "ТС260002", headers=headers(42)).json()["items"] == []
        assert client.get(base + "10001", headers=headers(42)).status_code == 422


def test_blocked_client_cannot_create_but_can_open_profile(monkeypatch):
    configure(monkeypatch)
    from uuid import uuid4
    from tests.test_integration import article_with_assets
    article = article_with_assets("RIGHTS", 1)
    start = now() + timedelta(days=5)
    with TestClient(app) as client:
        url = "/api/miniapp/admin/clients/42/booking-block"
        assert client.put(url, headers=headers(200), json={"blocked": True}).status_code == 403
        assert client.put(url, headers=headers(100), json={"blocked": True}).status_code == 200
        assert client.get("/api/miniapp/profile", headers=headers(42)).json()["start_screen"] == "blocked"
        payload = {"request_id": str(uuid4()), "start": start.isoformat(), "end": (start + timedelta(hours=1)).isoformat(),
                   "lines": [{"article_id": article, "quantity": 1}], "name": "QA", "contact": "@qa_user"}
        assert client.post("/api/miniapp/bookings", headers=headers(42), json=payload).status_code == 403
        assert client.get("/api/miniapp/profile/history", headers=headers(42)).status_code == 200
        assert client.put(url, headers=headers(100), json={"blocked": False}).status_code == 200
        assert client.post("/api/miniapp/bookings", headers=headers(42), json=payload).status_code == 201


def test_history_status_filter_and_sort_before_pagination(monkeypatch):
    configure(monkeypatch)
    base_time = now() - timedelta(days=30)
    with Session.begin() as session:
        for i in range(15):
            status = 'cancelled' if i % 3 == 0 else ('confirmed' if i % 2 else 'pending')
            session.add(Booking(customer_id=42, customer_name='QA', customer_contact='@qa',
                                starts_at=now(), ends_at=now() + timedelta(hours=1),
                                status=status, created_at=base_time + timedelta(minutes=i)))
        session.add(Booking(customer_id=43, customer_name='Other', customer_contact='@other',
                            starts_at=now(), ends_at=now() + timedelta(hours=1), status='pending'))
    with TestClient(app) as client:
        url = '/api/miniapp/profile/history?category=all&sort=date'
        first = client.get(url + '&page=0', headers=headers(42)).json()
        second = client.get(url + '&page=1', headers=headers(42)).json()
        assert first['total'] == 15
        assert all(item['status'] != 'cancelled' for item in first['items'])
        assert all(item['status'] == 'cancelled' for item in second['items'])
        statuses = client.get('/api/miniapp/profile/history?category=all&sort=status', headers=headers(42)).json()['items']
        assert [item['status'] for item in statuses] == sorted([item['status'] for item in statuses], key={'pending': 0, 'confirmed': 1}.get)
        cancelled = client.get('/api/miniapp/profile/history?category=status_cancelled', headers=headers(42)).json()
        assert cancelled['total'] == 5 and all(item['status'] == 'cancelled' for item in cancelled['items'])
        assert client.get('/api/miniapp/profile/history?sort=invalid', headers=headers(42)).status_code == 422


def test_staff_history_filters_and_sorts_before_pagination(monkeypatch):
    configure(monkeypatch)
    base_time = now() - timedelta(days=30)
    with Session.begin() as session:
        for i in range(27):
            status = 'cancelled' if i % 3 == 0 else ('confirmed' if i % 2 else 'pending')
            session.add(Booking(customer_id=42, customer_name='QA', customer_contact='@qa',
                                starts_at=now(), ends_at=now() + timedelta(hours=1),
                                assignee_id=100 if i % 2 else None,
                                status=status, created_at=base_time + timedelta(minutes=i)))
    with TestClient(app) as client:
        base = '/api/miniapp/admin/bookings?page_size=10&page='
        assert client.get(base + '0', headers=headers(42)).status_code == 403
        first = client.get(base + '0', headers=headers(100)).json()
        second = client.get(base + '1', headers=headers(100)).json()
        third = client.get(base + '2', headers=headers(100)).json()
        assert first['total'] == 27 and len(first['items']) == 10
        assert first['queues'] == {'review': 9, 'handover': 9, 'return': 0}
        review = client.get(base + '0&queue=review', headers=headers(100)).json()
        assert review['total'] == 9 and all(row['status'] == 'pending' for row in review['items'])
        assert all(row['status'] != 'cancelled' for row in first['items'])
        assert all(row['status'] != 'cancelled' for row in second['items'][:8])
        assert all(row['status'] == 'cancelled' for row in third['items'])
        assert len({row['id'] for row in first['items'] + second['items'] + third['items']}) == 27
        chosen = client.get(base + '0&status=cancelled&sort=status', headers=headers(100)).json()
        assert chosen['total'] == 9 and all(row['status'] == 'cancelled' for row in chosen['items'])
        mine = client.get(base + '0&scope=mine', headers=headers(100)).json()
        assert mine['total'] == 13 and all(row['assignee_id'] == 100 for row in mine['items'])
        target = third['items'][0]['id']
        linked = client.get(base + f'0&booking_id={target}', headers=headers(100)).json()
        assert linked['total'] == 1 and linked['items'][0]['id'] == target
        assert client.get(base + '0&status=fake', headers=headers(100)).status_code == 422


def test_staff_history_pages_preserve_allowlist_and_order(monkeypatch):
    from app.db import Audit, PIIAudit, SupportActivity, SupportThread
    from app.rental import booking_history
    configure(monkeypatch)
    with Session.begin() as session:
        booking = Booking(customer_id=42, customer_name='QA', customer_contact='@qa', starts_at=now(), ends_at=now()+timedelta(hours=1), status='pending')
        session.add(booking); session.flush(); booking_id = booking.id
        session.add_all([Audit(booking_id=booking_id, actor_id=100, action='confirmed') for _ in range(25)])
        session.add(PIIAudit(booking_id=booking_id, actor_id=200, action='verified'))
        session.add(PIIAudit(booking_id=booking_id, actor_id=200, action='profile_identity_revealed'))
        thread = SupportThread(customer_id=42, booking_id=booking_id, request_number='QA', screen='request')
        session.add(thread); session.flush()
        session.add(SupportActivity(thread_id=thread.id, actor_id=100, action='claimed'))
    expected = booking_history(booking_id)
    with TestClient(app) as client:
        url = f'/api/miniapp/admin/bookings/{booking_id}/history?page_size=10&page='
        assert client.get(url+'0', headers=headers(42)).status_code == 403
        pages = [client.get(url+str(page), headers=headers(100)).json() for page in range(3)]
        assert all(page['total'] == 27 for page in pages)
        assert [item for page in pages for item in page['items']] == expected
        assert 'profile_identity_revealed' not in str(pages)
        assert client.get(url+'-1', headers=headers(100)).status_code == 422


def test_support_thread_pagination_is_private_and_stable(monkeypatch):
    from app.db import SupportMessage, SupportThread
    configure(monkeypatch)
    with Session.begin() as session:
        for index in range(25):
            thread = SupportThread(customer_id=42, request_number=f'QA-{index}', screen='profile', created_at=now()-timedelta(minutes=index))
            session.add(thread); session.flush()
            if index == 0:
                session.add(SupportMessage(thread_id=thread.id, sender_id=100, direction='operator', ciphertext=b'x', nonce=b'x', delivered_at=now()))
        session.add(SupportThread(customer_id=43, request_number='OTHER', screen='profile'))
    with TestClient(app) as client:
        url='/api/miniapp/support/threads?page_size=10&page='
        first=client.get(url+'0', headers=headers(42)).json()
        second=client.get(url+'1', headers=headers(42)).json()
        third=client.get(url+'2', headers=headers(42)).json()
        assert first['total']==25 and [len(part['items']) for part in (first,second,third)]==[10,10,5]
        assert len({row['id'] for part in (first,second,third) for row in part['items']})==25
        assert first['items'][0]['status']=='Оператор ответил'
        assert all(row['request_number']!='OTHER' for part in (first,second,third) for row in part['items'])
        staff=client.get('/api/miniapp/admin/support?page=0&page_size=10', headers=headers(100)).json()
        assert staff['total']==26
        target=third['items'][0]['id']
        linked=client.get(f'/api/miniapp/admin/support?page=0&thread_id={target}', headers=headers(100)).json()
        assert linked['total']==1 and linked['items'][0]['id']==target
        assert client.get('/api/miniapp/admin/support?page=0', headers=headers(42)).status_code==403
