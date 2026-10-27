"""Small HTTP server for the Telegram Mini App without the admin website."""

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import date

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import __version__
from .db import init_db
from .miniapp import STATIC_DIR, router
from .documents import archive_completed_documents
from .notification_outbox import retry_pending_notifications
from .pii import purge_expired_identities
from .roles import validate_role_config
from .rental import expire_deletion_intents
from .availability_events import listen_for_availability
from .sla_escalations import queue_sla_escalations
from .support import retry_support_replies, purge_expired_support


async def retention_loop():
    last_purge = None
    while True:
        await asyncio.sleep(60)
        if last_purge != date.today():
            await asyncio.to_thread(purge_expired_identities)
            await asyncio.to_thread(purge_expired_support)
            last_purge = date.today()
        await asyncio.to_thread(queue_sla_escalations)
        await retry_pending_notifications()
        await retry_support_replies()


async def deletion_loop():
    while True:
        await asyncio.to_thread(expire_deletion_intents)
        await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(_app):
    validate_role_config()
    await asyncio.to_thread(init_db)
    await asyncio.to_thread(archive_completed_documents)
    await asyncio.to_thread(purge_expired_identities)
    await asyncio.to_thread(purge_expired_support)
    await retry_pending_notifications()
    task = asyncio.create_task(retention_loop())
    availability_task = asyncio.create_task(listen_for_availability())
    deletion_task = asyncio.create_task(deletion_loop())
    try:
        yield
    finally:
        task.cancel()
        availability_task.cancel()
        deletion_task.cancel()
        with suppress(asyncio.CancelledError):
            await task
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
