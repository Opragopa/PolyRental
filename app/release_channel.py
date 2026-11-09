"""Publish regular releases once; uncertain Telegram outcomes require reconciliation."""
import asyncio
from datetime import datetime, timedelta, timezone
from html import escape
import logging
import os

from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.types import LinkPreviewOptions
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from . import __version__
from .db import ReleasePublication, Session
from .release_notes import current_release

logger = logging.getLogger(__name__)


def render_post(release, html=True):
    clean = escape if html else lambda value: value
    title = f"{release['previous_version']} → {release['version']}"
    heading = f"<b>{clean(title)}</b>" if html else f"# {title}"
    parts = [heading + "\nЧто изменилось:"]
    for item in release["items"]:
        heading = item["title"].rstrip(".") + "."
        bold = f"<b>{clean(heading)}</b>" if html else f"**{heading}**"
        parts.append(f"{item['emoji']} {bold} {clean(item['text'])}")
    result = "\n\n".join(parts)
    if len(result.encode('utf-16-le')) // 2 > 4096:
        raise ValueError("Release post exceeds one Telegram message")
    return result


def enqueue(channel_id, release):
    with Session.begin() as session:
        session.execute(insert(ReleasePublication).values(channel_id=channel_id, version=release["version"],
            message=render_post(release)).on_conflict_do_nothing())


def claim(channel_id, version):
    timestamp = datetime.now(timezone.utc)
    with Session.begin() as session:
        row = session.scalar(select(ReleasePublication).where(ReleasePublication.channel_id == channel_id,
            ReleasePublication.version == version).with_for_update(skip_locked=True))
        if row is None:
            return None
        if row.status == "sending" and row.attempted_at < timestamp - timedelta(minutes=2):
            row.status, row.last_error = "uncertain", "InterruptedDelivery"
            logger.error("Release %s publication outcome is uncertain; check channel before retry", version)
        if row.status != "pending" or row.next_attempt_at and row.next_attempt_at > timestamp:
            return None
        row.status, row.attempted_at = "sending", timestamp
        row.attempts += 1
        return row.message


def finish(channel_id, version, status, message_id=None, error=None, retry_after=None):
    with Session.begin() as session:
        row = session.get(ReleasePublication, (channel_id, version), with_for_update=True)
        row.status, row.message_id, row.last_error = status, message_id, error
        row.sent_at = datetime.now(timezone.utc) if status == "sent" else None
        row.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=retry_after) if retry_after else None


def settled(channel_id, version):
    with Session() as session:
        row = session.get(ReleasePublication, (channel_id, version))
        return row is not None and row.status in {"sent", "uncertain"}


async def publish(bot, target):
    release = current_release()
    if release is None or release.get("channel_announcement", True) is False:
        return "skipped"
    if str(target).lstrip('-').isdigit() and await asyncio.to_thread(settled, int(target), release["version"]):
        return "unchanged"
    chat = await bot.get_chat(int(target) if str(target).lstrip('-').isdigit() else target)
    me = await bot.get_me()
    member = await bot.get_chat_member(chat.id, me.id)
    if chat.type != "channel" or member.status != "administrator" or not member.can_post_messages:
        raise PermissionError("Release bot requires channel post permission")
    # Never create a post for a hotfix; a pending regular-release post may finish.
    if __version__ == release["version"]:
        await asyncio.to_thread(enqueue, chat.id, release)
    message = await asyncio.to_thread(claim, chat.id, release["version"])
    if message is None:
        return "unchanged"
    try:
        sent = await asyncio.wait_for(bot.send_message(chat.id, message, parse_mode="HTML",
            link_preview_options=LinkPreviewOptions(is_disabled=True)), timeout=20)
    except (TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter) as exc:
        # Explicit API rejections are known not to have posted a message.
        await asyncio.to_thread(finish, chat.id, release["version"], "pending", error=type(exc).__name__,
                                retry_after=max(60, getattr(exc, "retry_after", 0)))
        logger.warning("Release %s publication rejected (%s); retry scheduled", release["version"], type(exc).__name__)
        return "pending"
    except BaseException as exc:
        # Telegram has no sendMessage idempotency key. A timeout/crash may happen
        # after delivery, so automatic resend here could duplicate a public post.
        await asyncio.shield(asyncio.to_thread(finish, chat.id, release["version"], "uncertain", error=type(exc).__name__))
        logger.error("Release %s publication outcome uncertain (%s)", release["version"], type(exc).__name__)
        if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
            raise
        return "uncertain"
    await asyncio.to_thread(finish, chat.id, release["version"], "sent", message_id=sent.message_id)
    return "sent"


async def publication_loop():
    # The HTTP server completes startup before the first release announcement.
    await asyncio.sleep(5)
    while True:
        target, token = os.getenv("RELEASE_CHANNEL", "").strip(), os.getenv("BOT_TOKEN", "")
        if target and token:
            try:
                from .bot import make_bot
                async with make_bot(token) as bot:
                    await publish(bot, target)
            except Exception as exc:
                logger.warning("Release publisher will retry after %s", type(exc).__name__)
        await asyncio.sleep(60)
