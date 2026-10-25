"""Small HTTP server for the Telegram Mini App without the admin website."""

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import date

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import __version__
from .db import Session, init_db
from .miniapp import STATIC_DIR, router
from .documents import archive_completed_documents
from .service import expire_holds
from .pii import purge_expired_identities


async def expiry_loop():
    last_purge = None
    while True:
        await asyncio.sleep(60)
        def expire():
            with Session.begin() as session:
                expire_holds(session)
        await asyncio.to_thread(expire)
        if last_purge != date.today():
            await asyncio.to_thread(purge_expired_identities)
            last_purge = date.today()


@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(init_db)
    await asyncio.to_thread(archive_completed_documents)
    await asyncio.to_thread(purge_expired_identities)
    task = asyncio.create_task(expiry_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, version=__version__)
app.include_router(router)
app.mount("/miniapp/static", StaticFiles(directory=STATIC_DIR), name="miniapp-static")


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}
