"""Exercise the legacy entry points with local mocks, without Telegram messages."""
import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from sqlalchemy import func, select

from app import bot
from app.db import Booking, Session
from app.rental import create_booking, save_equipment
from tests.test_integration import article_with_assets
from tests.test_regressions import now_interval


def test_chat_double_confirmation_is_idempotent(monkeypatch):
    article_id = article_with_assets("CHAT", 2)
    start, end = now_interval()
    message = SimpleNamespace(answer=AsyncMock())
    state = SimpleNamespace(clear=AsyncMock(), update_data=AsyncMock(), set_state=AsyncMock())
    asyncio.run(bot.begin_chat_booking(message, state))
    request_id = state.update_data.call_args.kwargs["request_id"]
    data = dict(request_id=request_id, ids=[article_id], name="Тест", contact="@qa_user",
                start=start.isoformat(), end=end.isoformat(), expected_total="200.00")
    state.get_state = AsyncMock(return_value=bot.Rent.review.state)
    state.get_data = AsyncMock(return_value=data)
    query = SimpleNamespace(from_user=SimpleNamespace(id=42), answer=AsyncMock(), message=message)
    notification = AsyncMock()
    monkeypatch.setattr(bot, "notify_managers", notification)
    async def double_click():
        await asyncio.gather(bot.confirm_booking(query, state, AsyncMock()),
                             bot.confirm_booking(query, state, AsyncMock()))
    asyncio.run(double_click())
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(Booking)) == 1
    assert notification.await_count == 1


def test_bot_catalog_errors_are_handled(monkeypatch):
    monkeypatch.setenv("ADMIN_IDS", "100")
    message = SimpleNamespace(from_user=SimpleNamespace(id=100), answer=AsyncMock(),
                              text="/add DUP")
    asyncio.run(bot.add_equipment(message))
    assert "Формат: /add" in message.answer.call_args.args[0]
    save_equipment("DUP", "Тест", "", 100, "available")
    message.text = "/add DUP Тест"
    asyncio.run(bot.add_equipment(message))
    assert "уже существует" in message.answer.call_args.args[0]


def test_legacy_panel_shows_articles_and_handles_document_conflict(monkeypatch):
    monkeypatch.setenv("ADMIN_IDS", "100")
    from app.web import app
    secret = next(m.kwargs["secret_key"] for m in app.user_middleware if "secret_key" in m.kwargs)
    client = TestClient(app)
    cookie = TimestampSigner(secret).sign(base64.b64encode(json.dumps({"admin_id":100}).encode())).decode()
    client.cookies.set("session", cookie)
    article_id = article_with_assets("WEB-CAMERA", 1)
    start, end = now_interval()
    booking_id = create_booking(42, "Тест", "@qa", start, end,
                                [{"article_id":article_id, "quantity":1}])
    response = client.get("/admin")
    assert response.status_code == 200 and "WEB-CAMERA × 1" in response.text
    assert f'/admin/bookings/{booking_id}/issued' not in response.text
    assert client.get(f"/admin/bookings/{booking_id}/documents/issue").status_code == 409
    assert client.post("/admin/equipment", data={"number":"NEW", "name":"Тест",
                                                "condition":"unknown"}).status_code == 409
