"""Verify test-server routing without making Telegram requests."""
import asyncio

import pytest

from app.bot import main_keyboard, make_bot, miniapp_url


@pytest.mark.parametrize("flag", [None, "0", "false", "true", "1"])
def test_http_entry_requires_explicit_test_environment(monkeypatch, flag):
    if flag is None:
        monkeypatch.delenv("TELEGRAM_TEST_ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("TELEGRAM_TEST_ENVIRONMENT", flag)
    monkeypatch.setenv("PUBLIC_URL", "http://192.0.2.1:8002/")
    if flag == "1":
        assert miniapp_url() == "http://192.0.2.1:8002/miniapp"
        assert main_keyboard().keyboard[0][0].web_app is None
    else:
        assert miniapp_url() is None
        assert main_keyboard().keyboard[0][0].web_app is None


@pytest.mark.parametrize("flag", ["0", "1"])
def test_bot_api_and_file_routes_use_same_environment(monkeypatch, flag):
    monkeypatch.setenv("TELEGRAM_TEST_ENVIRONMENT", flag)
    bot = make_bot("123:qa-environment")
    try:
        suffix = "test/" if flag == "1" else ""
        assert bot.session.api.api_url(bot.token, "getMe") == f"https://api.telegram.org/bot{bot.token}/{suffix}getMe"
        assert bot.session.api.file_url(bot.token, "photos/test.jpg") == f"https://api.telegram.org/file/bot{bot.token}/{suffix}photos/test.jpg"
    finally:
        asyncio.run(bot.session.close())
