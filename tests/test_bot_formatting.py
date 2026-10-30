import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiogram.enums import ParseMode

from app.booking_messages import booking_status_text
from app.bot import booking_created_text, change, reply_to_customer, support_message
from app.miniapp import notify_booking_status


def test_booking_message_waits_for_operator_without_deadline():
    booking = SimpleNamespace(id=42, hold_expires_at=None)
    text = booking_created_text(booking)
    assert "<b>Заявка №42 создана</b>" in text
    assert "Ожидает решения оператора" in text
    assert "до подтверждения или отмены" in text


def test_support_question_is_not_broadcast_to_admins(monkeypatch):
    import app.bot as bot_module
    monkeypatch.setenv("ADMIN_IDS", "100")
    saved = []
    monkeypatch.setattr(bot_module, "submit_question", lambda *args: (saved.append(args) or {"id": 1, "owner_id": None}))
    message = SimpleNamespace(text="<b>важно</b> & вопрос", from_user=SimpleNamespace(
        id=42, full_name="Анна <script>"), answer=AsyncMock())
    bot = SimpleNamespace(send_message=AsyncMock())
    state = SimpleNamespace(clear=AsyncMock())
    asyncio.run(support_message(message, state, bot))
    assert saved[0][-1] == message.text
    bot.send_message.assert_not_called()


def test_manager_reply_uses_protected_support_queue(monkeypatch):
    import app.bot as bot_module
    monkeypatch.setenv("ADMIN_IDS", "100")
    monkeypatch.setenv("PII_ADMIN_IDS", "100")
    saved = []
    monkeypatch.setattr(bot_module, "support_reply", lambda *args: (saved.append(args) or 5))
    monkeypatch.setattr(bot_module, "deliver_reply", AsyncMock(return_value=True))
    message = SimpleNamespace(text="/reply 42 <u>текст</u> & ещё", from_user=SimpleNamespace(id=100),
                              answer=AsyncMock())
    bot = SimpleNamespace(send_message=AsyncMock())
    asyncio.run(reply_to_customer(message, bot))
    assert saved == [(42, 100, "<u>текст</u> & ещё")]
    bot.send_message.assert_not_called()


def test_status_update_names_stage_and_escapes_operator():
    text = booking_status_text(14, "issued", "Мария <Сидорова> & ко")
    assert "Этап: <b>Выдача оборудования</b>" in text
    assert "Оператор: <b>Мария &lt;Сидорова&gt; &amp; ко</b>" in text
    assert "Статус: оборудование выдано." in text
    assert "Этап: <b>Проверка анкеты</b>" in booking_status_text(14, "identity_needs_changes", "Анна")
    assert "Статус: документы проверены." in booking_status_text(14, "identity_verified", "Анна")


def test_bot_command_reports_status_to_operator_without_customer_push(monkeypatch):
    import app.bot as bot_module
    monkeypatch.setenv("ADMIN_IDS", "100")
    monkeypatch.setattr(bot_module, "transition", lambda *_, **__: "confirmed")
    monkeypatch.setattr(bot_module, "get_booking", lambda *_: SimpleNamespace(customer_id=42))
    message = SimpleNamespace(text="/confirm 14", from_user=SimpleNamespace(id=100, full_name="Анна & Олег"),
                              answer=AsyncMock())
    bot = SimpleNamespace(send_message=AsyncMock())
    asyncio.run(change(message, bot))
    text = message.answer.call_args.args[0]
    assert "Этап: <b>Подтверждение заявки</b>" in text
    assert "Оператор: <b>Анна &amp; Олег</b>" in text
    bot.send_message.assert_not_called()


def test_miniapp_status_does_not_send_push(monkeypatch):
    import app.bot as bot_module

    class FakeBot:
        send_message = AsyncMock()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

    fake_bot = FakeBot()
    monkeypatch.setenv("BOT_TOKEN", "123:test-secret")
    monkeypatch.setattr(bot_module, "make_bot", lambda _: fake_bot)
    asyncio.run(notify_booking_status(14, 42, "return_inspection", "Иван <Петров>"))
    fake_bot.send_message.assert_not_called()
