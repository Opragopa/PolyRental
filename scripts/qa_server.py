"""Local browser QA on the isolated test DB; never load this from production.

docker compose --profile test run --rm --service-ports \
  -p 127.0.0.1:8001:8000 -v C:/PROJECTS/PolyRental:/app test python scripts/qa_server.py
"""
import base64
import hashlib
import hmac
import json
import io
import os
import sys
import time
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.environ.get("DATABASE_URL", "").rsplit("/", 1)[-1] != "polyrental_test":
    raise RuntimeError("QA server requires polyrental_test")

os.environ.update(BOT_TOKEN="123:local-qa-only", ADMIN_IDS="100", PII_ADMIN_IDS="200",
                  PII_MASTER_KEY=base64.urlsafe_b64encode(b"q" * 32).decode(),
                  OPERATOR_NAME="QA оператор", OPERATOR_ADDRESS="Тестовая среда",
                  OPERATOR_CONTACT="qa@example.test", PRIVACY_POLICY_VERSION="qa-v1")

from fastapi.responses import HTMLResponse
from app.miniapp_server import app
from app import miniapp
from app.db import Article, Session, init_db
from app.rental import (availability, create_booking, get_booking, now, save_article,
                        save_equipment, transition, assign_booking_assets)


async def no_notification(*args):
    pass


miniapp.notify_new_booking = miniapp.notify_booking_status = miniapp.notify_cancelled_booking = no_notification


@app.get("/qa/{role}", response_class=HTMLResponse)
def qa_page(role: str):
    user_id = {"customer": 42, "admin": 100, "pii": 200}[role]
    data = {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id, "first_name": "QA"})}
    check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
    secret = hmac.new(b"WebAppData", os.environ["BOT_TOKEN"].encode(), hashlib.sha256).digest()
    data["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    sdk = "<script>window.Telegram={WebApp:{initData:" + json.dumps(urlencode(data)) + "}};</script>"
    html = miniapp.miniapp_html()
    metrics = """<script>addEventListener('DOMContentLoaded',()=>{
      const measure=()=>parent.postMessage({qaMetrics:{width:document.documentElement.clientWidth,
        scrollWidth:document.documentElement.scrollWidth,
        overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();
          return r.width && (r.right>document.documentElement.clientWidth+1||r.left< -1);})
          .map(e=>e.id||e.className||e.tagName)}},location.origin);
      new ResizeObserver(measure).observe(document.body);
      new MutationObserver(measure).observe(document.body,{childList:true,subtree:true,attributes:true});
    });</script>"""
    return html.replace('<script src="https://telegram.org/js/telegram-web-app.js?64"></script>', sdk + metrics)


@app.get("/qa-mobile/{role}", response_class=HTMLResponse)
def mobile_page(role: str, width: int = 390):
    if role not in {"customer", "admin", "pii"} or width not in {320, 390, 430}:
        return HTMLResponse("Unknown QA viewport", status_code=404)
    return f'''<html><body style="margin:0;background:#ddd"><iframe title="QA mobile {width}" src="/qa/{role}" style="display:block;width:{width}px;height:844px;border:0"></iframe>
      <output id="qa-metrics"></output><script>addEventListener('message',event=>{{
      if(event.origin===location.origin && event.data.qaMetrics)document.querySelector('output').textContent=JSON.stringify(event.data.qaMetrics);
      }});</script></body></html>'''


if __name__ == "__main__":
    init_db()
    with Session() as session:
        seeded = session.query(Article).filter_by(sku="QA-CAMERA").first()
    if not seeded:
        article_id = save_article("QA-CAMERA", "QA Камера", "Тестовый комплект", 100, "camera")
        for index in range(1, 4):
            save_equipment(f"QA-CAM-{index}", "", "", 0, "available", article_id=article_id,
                           storage_location=f"A-0{index}")
        # Keep the fixture valid when the booking notice is four calendar days.
        start = now() + timedelta(days=4)
        booking_id = create_booking(42, "QA клиент", "@qa", start, start + timedelta(hours=2),
                                    [{"article_id": article_id, "quantity": 1}])
        transition(booking_id, "confirmed", 100)
        from PIL import Image
        from app.pii import consent_text, submit_identity, review_identity
        photo = io.BytesIO()
        Image.new("RGB", (32, 32), "white").save(photo, format="JPEG")
        fields = {"full_name": "Тестовый Клиент", "birth_date": "2000-01-01",
                  "passport_series": "0000", "passport_number": "000000",
                  "passport_issued_at": "2020-01-01", "passport_issuer": "Тест",
                  "passport_division_code": "000-000", "registration_address": "Тестовый адрес",
                  "residential_address": "Тестовый адрес", "student_id_number": "12345678",
                  "student_institution": "Санкт-Петербургский государственный университет"}
        submit_identity(booking_id, 42, fields,
                        {kind: (photo.getvalue(), "image/jpeg") for kind in
                         ("passport_main", "passport_registration", "student_front")},
                        "qa-v1", hashlib.sha256(consent_text().encode()).hexdigest())
        review_identity(booking_id, 200, True)
        assign_booking_assets(booking_id, 100)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("QA_PORT", "8000")))
