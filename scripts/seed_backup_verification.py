"""Create representative synthetic encrypted records exclusively in polyrental_test."""
import base64
import io
from PIL import Image
from datetime import timedelta
import os
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
if os.getenv("DATABASE_URL","").rsplit("/",1)[-1]!="polyrental_test":
    raise RuntimeError("Backup QA seed requires the isolated polyrental_test database")
os.environ.update(ADMIN_IDS="100",PII_ADMIN_IDS="100",BOT_TOKEN="",ENFORCE_HANDOVER_SCHEDULE="false",
    PII_MASTER_KEY=base64.urlsafe_b64encode(b"x"*32).decode())

from app.db import Session,StaffRole,init_db
from app.rental import (assign_booking_assets,create_booking,get_booking,now,record_inspection,save_article,save_equipment,transition)
from app.booking_changes import propose_change
from tests.workflow_helpers import verified_identity,paper

init_db()
with Session.begin() as session:
    role=session.get(StaffRole,100)
    if role is None:session.add(StaffRole(telegram_id=100,role="admin"))
    else:role.role="admin"
tag="TEST-BACKUP-"+uuid4().hex[:8]
article=save_article(tag,tag,"Synthetic backup verification",0)
save_equipment(tag,tag,"",0,"available",article_id=article)
from app.catalog_images import save_image
preview=io.BytesIO();Image.new("RGB",(32,32),"blue").save(preview,format="PNG")
save_image(article,preview.getvalue(),100)
start=now()+timedelta(days=5)
booking=create_booking(42,"TEST-Client","@synthetic",start,start+timedelta(hours=2),[{"article_id":article,"quantity":1}])
transition(booking,"confirmed",100);verified_identity(booking);assign_booking_assets(booking,100)
for asset in get_booking(booking).assets:record_inspection(booking,asset.equipment_id,"pre_issue","pass",{},"",100)
transition(booking,"ready",100);paper(booking);transition(booking,"issued",100)
other=create_booking(43,"TEST-Other","@synthetic",start+timedelta(days=2),start+timedelta(days=2,hours=2),[{"article_id":article,"quantity":1}])
propose_change(other,100,"client_fix","TEST-Private encrypted comment")
print("Synthetic encrypted receipt, signature, identity and request-change fixture created in polyrental_test")
