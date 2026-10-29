import asyncio
import hashlib
import hmac
import os
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from zoneinfo import ZoneInfo
from urllib.parse import urlencode

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from icalendar import Calendar, Event
from itsdangerous import BadSignature, URLSafeSerializer
from sqlalchemy.exc import IntegrityError
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .db import Session, init_db
from .documents import ensure_templates, render_document
from .miniapp import STATIC_DIR, router as miniapp_router
from .rental import TRANSITIONS, expire_deletion_intents
from .receipt_archive import purge_expired_receipts
from .catalog_titles import catalog_title
from .availability_events import listen_for_availability
from .roles import is_staff, audit_admin_access, validate_role_config, staff_allows
from .service import Conflict, expire_holds, list_bookings, list_equipment, save_equipment, transition

MOSCOW = ZoneInfo("Europe/Moscow")


async def expiry_loop():
    last_receipt_purge = None
    last_workflow_tick = None
    while True:
        await asyncio.sleep(1)
        def expire():
            with Session.begin() as session:
                expire_holds(session)
            expire_deletion_intents()
        await asyncio.to_thread(expire)
        if last_workflow_tick is None or time.monotonic()-last_workflow_tick>=60:
            from .booking_changes import process_change_deadlines
            from .roadmap import queue_optional_reminders
            from .notification_outbox import retry_pending_notifications
            from .sla_escalations import queue_sla_escalations
            from .support import retry_support_replies
            await asyncio.to_thread(process_change_deadlines)
            await asyncio.to_thread(queue_optional_reminders)
            await asyncio.to_thread(queue_sla_escalations)
            await retry_pending_notifications()
            await retry_support_replies()
            last_workflow_tick=time.monotonic()
        if last_receipt_purge is None or time.monotonic() - last_receipt_purge >= 86400:
            await asyncio.to_thread(purge_expired_receipts)
            from .pii import purge_expired_identities
            from .support import purge_expired_support
            await asyncio.to_thread(purge_expired_identities)
            await asyncio.to_thread(purge_expired_support)
            last_receipt_purge = time.monotonic()


def verify_telegram(data):
    token = os.getenv("BOT_TOKEN", "")
    if not token or not data.get("hash") or not data.get("id") or not data.get("auth_date"):
        return False
    if not str(data["id"]).isdigit() or not str(data["auth_date"]).isdigit():
        return False
    age = time.time() - int(data["auth_date"])
    if age < 0 or age > int(os.getenv("TELEGRAM_AUTH_MAX_AGE", "86400")):
        return False
    check = "\n".join(f"{key}={data[key]}" for key in sorted(data) if key != "hash")
    secret = hashlib.sha256(token.encode()).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, data["hash"])


@asynccontextmanager
async def lifespan(app):
    validate_role_config()
    init_db()
    from .pii import encrypt_legacy_review_comments
    encrypt_legacy_review_comments()
    ensure_templates()
    task = asyncio.create_task(expiry_loop())
    availability_task = asyncio.create_task(listen_for_availability())
    try:
        yield
    finally:
        task.cancel()
        availability_task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        with suppress(asyncio.CancelledError):
            await availability_task


app = FastAPI(lifespan=lifespan, version=__version__)
app.add_middleware(SessionMiddleware, secret_key=os.getenv("SESSION_SECRET", "change-me-before-deploy"), same_site="lax", https_only=os.getenv("PUBLIC_URL", "").startswith("https://"))
app.include_router(miniapp_router)
app.mount("/miniapp/static", StaticFiles(directory=STATIC_DIR), name="miniapp-static")


def require_admin(request):
    admin = request.session.get("admin_id")
    if not staff_allows(admin, "operator"):
        raise HTTPException(403, "Войдите через Telegram как менеджер")
    audit_admin_access(admin, "web")
    return admin


def page(title, body):
    return HTMLResponse(f'''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>body{{font:16px system-ui;max-width:1100px;margin:30px auto;padding:0 15px;background:#f7f8fa;color:#17212b}}section{{background:white;padding:18px;margin:15px 0;border-radius:10px}}input,select,button{{padding:8px;margin:4px}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #ddd;text-align:left;padding:8px}}a{{color:#1673bd}}</style><h1>{title}</h1>{body}</html>''')


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}


@app.get("/login")
def login():
    from html import escape
    token = os.getenv("BOT_TOKEN", "")
    username = os.getenv("BOT_USERNAME", "")
    if not token or not username:
        return page("Вход", "<p>Настройте BOT_TOKEN и BOT_USERNAME.</p>")
    callback = escape(os.getenv("PUBLIC_URL", "http://localhost:8000").rstrip("/") + "/auth/telegram", quote=True)
    return page("Вход менеджера", f'<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="{escape(username, quote=True)}" data-size="large" data-auth-url="{callback}" data-request-access="write"></script>')


@app.get("/auth/telegram")
def auth_telegram(request: Request):
    data = dict(request.query_params)
    if not verify_telegram(data) or not is_staff(int(data["id"])):
        raise HTTPException(403, "Telegram ID не разрешен или подпись неверна")
    request.session["admin_id"] = int(data["id"])
    return RedirectResponse("/admin", status_code=303)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/admin")
def dashboard(request: Request):
    from html import escape
    require_admin(request)
    parts = ['<p><a href="/admin/calendar">Календарь</a> · <a href="/admin/equipment">Оборудование</a></p><form method="post" action="/logout"><button>Выйти</button></form>']
    parts.append('<section><h2>Заявки</h2><table><tr><th>№</th><th>Клиент</th><th>Период</th><th>Оборудование</th><th>Статус</th><th>Действия</th></tr>')
    for booking in list_bookings():
        items = ", ".join(f"{escape(catalog_title(line.article.name, line.article.kind, line.article.brand, line.article.key_spec))} × {line.quantity}" for line in booking.lines)
        labels = {"confirmed": "Подтвердить", "cancelled": "Отменить", "preparing": "Подготовить",
                  "ready": "Готов", "issued": "Выдать", "return_inspection": "Начать возврат", "returned": "Завершить возврат"}
        actions = " ".join(f'<form style="display:inline" method="post" action="/admin/bookings/{booking.id}/{action}"><button>{labels[action]}</button></form>' for action in sorted(TRANSITIONS.get(booking.status, set())))
        docs = " ".join(f'<a href="/admin/bookings/{booking.id}/documents/{kind}">{label}</a>' for kind, label in (("contract", "Договор"), ("issue", "Акт выдачи"), ("return", "Акт возврата")))
        parts.append(f'<tr><td>{escape(booking.human_number or "Заявка")}</td><td>{escape(booking.customer_name)}<br>{escape(booking.customer_contact)}</td><td>{booking.starts_at.astimezone(MOSCOW):%d.%m.%Y %H:%M}–{booking.ends_at.astimezone(MOSCOW):%d.%m.%Y %H:%M} МСК</td><td>{items}</td><td>{booking.status}</td><td>{actions}<br>{docs}</td></tr>')
    parts.append('</table></section>')
    return page("PolyRental — менеджер", "".join(parts))


@app.post("/admin/bookings/{booking_id}/{action}")
async def change_booking(request: Request, booking_id: int, action: str):
    admin = require_admin(request)
    if not await asyncio.to_thread(staff_allows, admin, "manager" if action == "confirmed" else "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        status = await asyncio.to_thread(transition, booking_id, action, admin)
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc))
    if status == "expired":
        raise HTTPException(409, "Удержание истекло; создайте новую заявку")
    return RedirectResponse("/admin", status_code=303)


@app.get("/admin/equipment")
def equipment_page(request: Request):
    from html import escape
    require_admin(request)
    rows = []
    for item in list_equipment():
        rows.append(f'<tr><td>{item.id}</td><td>{escape(item.inventory_number)}</td><td>{escape(item.name)}</td><td>{item.condition}</td></tr>')
    form = '''<section><h2>Добавить или обновить экземпляр</h2><form method="post"><input name="equipment_id" type="number" placeholder="ID для изменения"><input name="number" required placeholder="Инвентарный номер"><input name="name" required placeholder="Название"><input name="description" placeholder="Описание"><input name="image_url" type="url" placeholder="HTTPS-ссылка на фото (необязательно)"><select name="condition"><option value="available">Доступно</option><option value="maintenance">Ремонт</option><option value="retired">Списано</option></select><button>Сохранить</button></form></section>'''
    return page("Оборудование", '<p><a href="/admin">← Заявки</a></p><section><table><tr><th>ID</th><th>Номер</th><th>Название</th><th>Состояние</th></tr>' + "".join(rows) + '</table></section>' + form)


@app.post("/admin/equipment")
def equipment_save(request: Request, number: str = Form(), name: str = Form(), description: str = Form(""), image_url: str = Form(""), condition: str = Form(), equipment_id: str = Form("")):
    require_admin(request)
    try:
        save_equipment(number, name, description, 0, condition, int(equipment_id) if equipment_id else None, image_url or (None if equipment_id else ""))
    except (ValueError, Conflict, IntegrityError) as exc:
        raise HTTPException(409, str(exc))
    return RedirectResponse("/admin/equipment", status_code=303)


@app.get("/admin/calendar")
def calendar_page(request: Request):
    require_admin(request)
    bookings = [b for b in list_bookings(limit=None) if b.status in {"pending", "confirmed", "preparing", "ready", "issued", "return_inspection"}]
    rows = "".join(f'<tr><td>#{b.id}</td><td>{b.starts_at.astimezone(MOSCOW):%d.%m.%Y %H:%M}</td><td>{b.ends_at.astimezone(MOSCOW):%d.%m.%Y %H:%M}</td><td>{b.status}</td></tr>' for b in sorted(bookings, key=lambda b: b.starts_at))
    url = "/calendar.ics?" + urlencode({"token": os.getenv("ICAL_TOKEN", "")})
    return page("Календарь броней", f'<p><a href="/admin">← Заявки</a> · <a href="{url}">Подписка iCal</a></p><section><table><tr><th>Заявка</th><th>Начало МСК</th><th>Конец МСК</th><th>Статус</th></tr>{rows}</table></section>')


@app.get("/calendar/{token}.ics")
def calendar_feed(token: str):
    expected = os.getenv("ICAL_TOKEN", "")
    if not expected or not hmac.compare_digest(token, expected):
        raise HTTPException(404)
    cal = Calendar()
    cal.add("prodid", "-//PolyRental//Calendar//RU")
    cal.add("version", "2.0")
    for booking in list_bookings(limit=None):
        if booking.status not in {"confirmed", "preparing", "ready", "issued", "return_inspection"}:
            continue
        event = Event()
        event.add("uid", f"booking-{booking.id}@polyrental")
        equipment = ", ".join(f"{line.article.name} × {line.quantity}" for line in booking.lines)
        event.add("summary", f"Аренда {booking.human_number or 'заявка'}: {equipment or 'оборудование'}")
        event.add("description", f"PolyRental · статус: {booking.status}")
        event.add("dtstart", booking.starts_at)
        event.add("dtend", booking.ends_at)
        cal.add_component(event)
    return Response(cal.to_ical(), media_type="text/calendar")


@app.get("/admin/bookings/{booking_id}/documents/{kind}")
def document(request: Request, booking_id: int, kind: str):
    actor_id = require_admin(request)
    from .documents import operator_document
    from .roles import configured_ids
    if actor_id not in configured_ids("PII_ADMIN_IDS"):
        raise HTTPException(403, "Нет доступа к персональным данным")
    try:
        body, filename = operator_document(booking_id, kind, actor_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Conflict as exc:
        raise HTTPException(409, str(exc))
    return Response(body, media_type="application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document", headers={"Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="{filename}"'})
