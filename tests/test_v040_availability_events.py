import asyncio
from sqlalchemy import text
from app.availability_events import listen_for_availability, subscribe, unsubscribe
from app.db import Session


def test_availability_changes_publish_only_after_commit():
    async def scenario():
        queue = subscribe()
        task = asyncio.create_task(listen_for_availability())
        try:
            await asyncio.wait_for(queue.get(), timeout=5)  # listener ready/reconnect
            def rollback_change():
                with Session() as session:
                    session.execute(text("INSERT INTO articles (sku,name,hourly_rate,description,composition,category,inspection_profile,image_url,buffer_hours,is_active) VALUES ('EVENT-ROLLBACK','Test',0,'','','generic','generic','',24,true)"))
                    session.rollback()
            await asyncio.to_thread(rollback_change)
            try:
                await asyncio.wait_for(queue.get(), timeout=.2)
                assert False, 'rolled-back changes must not notify'
            except asyncio.TimeoutError:
                pass
            def commit_change():
                with Session.begin() as session:
                    session.execute(text("INSERT INTO articles (sku,name,hourly_rate,description,composition,category,inspection_profile,image_url,buffer_hours,is_active) VALUES ('EVENT-COMMIT','Test',0,'','','generic','generic','',24,true)"))
            await asyncio.to_thread(commit_change)
            assert await asyncio.wait_for(queue.get(), timeout=5) is True
        finally:
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass
            unsubscribe(queue)
    asyncio.run(scenario())
