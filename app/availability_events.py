"""One PostgreSQL listener per process, with bounded fanout to connected clients."""
import asyncio
import logging
import os
import psycopg

logger = logging.getLogger(__name__)
_subscribers = set()


def subscribe():
    queue = asyncio.Queue(maxsize=1)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue):
    _subscribers.discard(queue)


def publish():
    for queue in tuple(_subscribers):
        if not queue.full():
            queue.put_nowait(True)


async def listen_for_availability():
    dsn = os.getenv('DATABASE_URL', 'postgresql://polyrental:polyrental@localhost:5432/polyrental').replace('postgresql+psycopg://', 'postgresql://', 1)
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
                await conn.execute('LISTEN polyrental_availability')
                publish()  # Reconcile after initial connection or reconnect.
                async for _ in conn.notifies():
                    publish()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning('Availability listener unavailable (%s); retrying', type(exc).__name__)
            await asyncio.sleep(5)
