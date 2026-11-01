"""Small HTTP server for the Telegram Mini App without the admin website."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import date

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import __version__
from .db import init_db
from .miniapp import STATIC_DIR, router
from .documents import archive_completed_documents
from .notification_outbox import retry_pending_notifications
from .pii import purge_expired_identities, encrypt_legacy_review_comments
from .receipt_archive import purge_expired_receipts
from .roles import validate_role_config
from .rental import expire_deletion_intents
from .availability_events import listen_for_availability
from .sla_escalations import queue_sla_escalations
from .support import retry_support_replies, purge_expired_support
from .booking_changes import process_change_deadlines
from .roadmap import queue_optional_reminders


async def retention_loop():
    last_purge = None
    while True:
        await asyncio.sleep(60)
        if last_purge != date.today():
            await asyncio.to_thread(purge_expired_identities)
            await asyncio.to_thread(purge_expired_receipts)
            await asyncio.to_thread(purge_expired_support)
            last_purge = date.today()
        await asyncio.to_thread(queue_sla_escalations)
        await asyncio.to_thread(process_change_deadlines)
        await asyncio.to_thread(queue_optional_reminders)
        await retry_support_replies()


async def deletion_loop():
    while True:
        await asyncio.to_thread(expire_deletion_intents)
        await asyncio.sleep(1)


async def notification_loop():
    while True:
        try:
            await retry_pending_notifications()
        except Exception as exc:
            logging.getLogger(__name__).warning("Notification worker will retry after %s", type(exc).__name__)
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(_app):
    validate_role_config()
    await asyncio.to_thread(init_db)
    await asyncio.to_thread(encrypt_legacy_review_comments)
    await asyncio.to_thread(archive_completed_documents)
    await asyncio.to_thread(purge_expired_identities)
    await asyncio.to_thread(purge_expired_receipts)
    await asyncio.to_thread(purge_expired_support)
    await retry_pending_notifications()
    task = asyncio.create_task(retention_loop())
    availability_task = asyncio.create_task(listen_for_availability())
    deletion_task = asyncio.create_task(deletion_loop())
    notification_task = asyncio.create_task(notification_loop())
    try:
        yield
    finally:
        task.cancel()
        availability_task.cancel()
        deletion_task.cancel()
        notification_task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        with suppress(asyncio.CancelledError):
            await notification_task
        with suppress(asyncio.CancelledError):
            await availability_task
        with suppress(asyncio.CancelledError):
            await deletion_task


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, version=__version__)
app.include_router(router)
app.mount("/miniapp/static", StaticFiles(directory=STATIC_DIR), name="miniapp-static")


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}
