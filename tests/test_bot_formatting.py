import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

from aiogram.enums import ParseMode

from app.bot import booking_created_text, reply_to_customer, support_message


def test_booking_message_highlights_deadline():
    booking = SimpleNamespace(id=42, hold_expires_at=datetime(2026, 10, 26, 14, 30,
                                                               tzinfo=ZoneInfo("Europe/Moscow")))
    text = booking_created_text(booking)
    assert "<b>Заявка №42 создана</b>" in text
    assert "<i>Ожидает ответа менеджера</i>" in text
    assert "<u>26.10.2026 14:30 МСК</u>" in text


def test_support_message_escapes_user_text(monkeypatch):
    monkeypatch.setenv("ADMIN_IDS", "100")
    message = SimpleNamespace(text="<b>важно</b> & вопрос", from_user=SimpleNamespace(
        id=42, full_name="Анна <script>"), answer=AsyncMock())
    bot = SimpleNamespace(send_message=AsyncMock())
    state = SimpleNamespace(clear=AsyncMock())
    asyncio.run(support_message(message, state, bot))
    text = bot.send_message.call_args.args[1]
    assert "&lt;b&gt;важно&lt;/b&gt; &amp; вопрос" in text
    assert "Анна &lt;script&gt;" in text
    assert bot.send_message.call_args.kwargs["parse_mode"] == ParseMode.HTML


def test_manager_reply_escapes_dynamic_body(monkeypatch):
    monkeypatch.setenv("ADMIN_IDS", "100")
    message = SimpleNamespace(text="/reply 42 <u>текст</u> & ещё", from_user=SimpleNamespace(id=100),
                              answer=AsyncMock())
    bot = SimpleNamespace(send_message=AsyncMock())
    asyncio.run(reply_to_customer(message, bot))
    text = bot.send_message.call_args.args[1]
    assert "&lt;u&gt;текст&lt;/u&gt; &amp; ещё" in text
    assert bot.send_message.call_args.kwargs["parse_mode"] == ParseMode.HTML
