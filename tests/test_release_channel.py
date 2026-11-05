import asyncio
import pytest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import SendMessage
from sqlalchemy import select

from app import release_channel as channel
from app.db import ReleasePublication, Session


@pytest.fixture(autouse=True)
def regular_release_fixture(monkeypatch):
    monkeypatch.setattr('app.release_notes.__version__', '0.5.1')


class FakeBot:
    def __init__(self, failure=None): self.messages=[]; self.failure=failure
    async def get_chat(self, target): return SimpleNamespace(id=-100123,type='channel')
    async def get_me(self): return SimpleNamespace(id=1)
    async def get_chat_member(self,*args): return SimpleNamespace(status='administrator',can_post_messages=True)
    async def send_message(self, chat, message, **kwargs):
        self.messages.append(message)
        await asyncio.sleep(0.01)
        if self.failure: raise self.failure
        return SimpleNamespace(message_id=17)


def test_parallel_workers_and_restart_publish_only_one_complete_regular_release(monkeypatch):
    monkeypatch.setattr(channel,'__version__','0.5.1')
    bot=FakeBot()
    async def run(): return await asyncio.gather(channel.publish(bot,'-100123'),channel.publish(bot,'-100123'))
    assert 'sent' in asyncio.run(run())
    assert len(bot.messages)==1
    assert asyncio.run(channel.publish(bot,'-100123'))=='unchanged'
    release=channel.current_release()
    assert all(item['text'] in bot.messages[0] for item in release['items'])
    with Session() as session:
        row=session.get(ReleasePublication,(-100123,'0.5.1'))
        assert row.status=='sent' and row.message_id==17 and row.attempts==1


def test_hotfix_creates_no_new_post(monkeypatch):
    monkeypatch.setattr(channel,'__version__','0.5.1-hotfix-1')
    bot=FakeBot()
    assert asyncio.run(channel.publish(bot,'-100123'))=='unchanged'
    assert not bot.messages
    with Session() as session: assert not session.scalars(select(ReleasePublication)).all()


def test_timeout_is_not_retried_automatically_because_it_may_have_delivered(monkeypatch):
    monkeypatch.setattr(channel,'__version__','0.5.1')
    bot=FakeBot(TimeoutError())
    assert asyncio.run(channel.publish(bot,'-100123'))=='uncertain'
    assert asyncio.run(channel.publish(bot,'-100123'))=='unchanged'
    assert len(bot.messages)==1
    with Session() as session:
        assert session.get(ReleasePublication,(-100123,'0.5.1')).status=='uncertain'


def test_known_telegram_rejection_schedules_retry_and_keeps_one_row(monkeypatch):
    monkeypatch.setattr(channel,'__version__','0.5.1')
    bot=FakeBot(TelegramBadRequest(SendMessage(chat_id=-100123,text='x'),'no permission'))
    assert asyncio.run(channel.publish(bot,'-100123'))=='pending'
    assert asyncio.run(channel.publish(bot,'-100123'))=='unchanged'
    with Session() as session:
        row=session.get(ReleasePublication,(-100123,'0.5.1'))
        assert row.status=='pending' and row.next_attempt_at and row.last_error=='TelegramBadRequest'


def test_renderer_uses_all_audiences_and_escapes_telegram_html():
    release={'previous_version':'0.5.0','version':'0.5.1','items':[
        {'emoji':'📋','title':'Добавлен <товар>','text':'A & B','audience':'staff'}]}
    assert '<b>Добавлен &lt;товар&gt;.</b> A &amp; B' in channel.render_post(release)
    assert channel.render_post(release).startswith('<b>0.5.0 → 0.5.1</b>\nЧто изменилось:')
    assert channel.render_post(release,html=False).startswith('# 0.5.0 → 0.5.1\nЧто изменилось:')
    assert '**Добавлен <товар>.** A & B' in channel.render_post(release,html=False)
