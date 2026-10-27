"""Customer-facing Telegram Mini App API."""

import asyncio
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qsl, urlencode
from uuid import UUID

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form, Header,
                     HTTPException, Query, UploadFile)
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from aiogram.enums import ParseMode
from icalendar import Calendar, Event
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, func, and_

from .documents import archived_document, operator_document
from .catalog_import import MAX_CSV_BYTES, import_catalog_csv
from .cart import CartConflict, get_cart, put_cart
from .availability_events import subscribe as subscribe_availability, unsubscribe as unsubscribe_availability
from .catalog_titles import catalog_title
from .request_sla import request_sla
from .support import (SupportConflict, submit_question, list_threads as list_support_threads,
                      claim_thread, read_messages as read_support_messages, reply as support_reply,
                      resolve_thread, reassign_thread, deliver_reply)
from .client_profile import profile_state, mark_onboarding_shown, complete_onboarding, record_client_mode, set_reminders_enabled, set_client_block
from .booking_messages import booking_status_text
from .notification_outbox import notify, notify_actionable
from .operator_preferences import preferences as operator_preferences, save_preferences as save_operator_preferences
from . import __version__
from .roles import configured_ids, is_staff, role_for, audit_admin_access, staff_allows
from .db import BookingDocument, Inspection, ReceiptArchive, Session, SupportMessage, SupportThread
from .receipt_archive import ReceiptExpired, customer_receipt_pdf
from .pii import (DOCUMENT_KINDS, IdentityFieldError, _master_key, block_identity, consent_text, delete_identity,
                  identity_document, identity_status, masked_identity, pii_admin_ids,
                  reusable_identity_fields,
                  reusable_identity_document,
                  reveal_identity, review_identity, sanitize_image, submit_identity,
                  validate_identity_payload)
from .rental import (ClientBlocked, Conflict, assign_booking_assets, availability, booking_history,
                     claim_booking_operation, create_booking, operation_lease_states,
                     close_repair, delete_booking, restore_booking, set_booking_line_deleted, set_booking_asset_deleted, create_deletion_intent, cancel_deletion_intent, schedule_legacy_deletion, deletion_undo_seconds, reassign_booking, hide_test_booking, set_booking_test_flag, set_article_test_flag, delete_dependency, delete_equipment, get_booking,
                     list_articles, list_bookings, list_customer_bookings, list_hidden_test_bookings, customer_history_page,
                     list_dependencies, list_equipment, list_repairs, mark_act_signed,
                     record_inspection, release_booking_operation, save_article, save_dependency, save_equipment,
                     transition, update_booking_contact, validate_interval, return_for_rework)
from .universities import SAINT_PETERSBURG_UNIVERSITIES

class PrivateRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def no_store(request):
            response = await handler(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return no_store


router = APIRouter(route_class=PrivateRoute)
STATIC_DIR = Path(__file__).with_name("miniapp_static")
_PII_REQUESTS = defaultdict(deque)
_DOCUMENT_DOWNLOAD_TOKENS = {}


def _limit_pii(user_id, scope, maximum=30, window=60):
    key, current = (user_id, scope), time.monotonic()
    events = _PII_REQUESTS[key]
    while events and events[0] <= current - window:
        events.popleft()
    if len(events) >= maximum:
        raise HTTPException(429, "Слишком много запросов. Повторите позже")
    events.append(current)


def verify_init_data(raw: str):
    """Return the signed Telegram user or reject untrusted/expired initData."""
    token = os.getenv("BOT_TOKEN", "")
    if not token or not raw or len(raw) > 8192:
        return None
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
        data = dict(pairs)
        if len(pairs) != len(data) or not data.get("hash") or not data.get("auth_date") or not data.get("user"):
            return None
        timestamp = int(data["auth_date"])
        age = time.time() - timestamp
        if age < 0 or age > int(os.getenv("TELEGRAM_AUTH_MAX_AGE", "86400")):
            return None
        check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()) if key != "hash")
        secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, data["hash"]):
            return None
        user = json.loads(data["user"])
        if not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] <= 0:
            return None
        return user
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        return None


def require_customer(x_telegram_init_data: str = Header(default="")):
    user = verify_init_data(x_telegram_init_data)
    if user is None:
        raise HTTPException(401, "Откройте приложение через Telegram ещё раз")
    return user


def _ids(name):
    return configured_ids(name)


def require_admin(user=Depends(require_customer)):
    if not is_staff(user["id"]):
        raise HTTPException(403, "Доступ только для сотрудников")
    return user


def require_system_admin(user=Depends(require_customer)):
    if user["id"] not in configured_ids("ADMIN_IDS"):
        raise HTTPException(403, "Доступ только для администратора")
    return user


def operator_name(user):
    name = " ".join(filter(None, [user.get("first_name", ""), user.get("last_name", "")])).strip()
    return name or (f"@{user['username']}" if user.get("username") else f"оператор {user['id']}")


def require_pii_admin(user=Depends(require_customer)):
    if user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Нет доступа к персональным данным")
    return user


def booking_view(booking):
    return {
        "id": booking.id,
        "is_test": booking.is_test,
        "human_number": booking.human_number,
        "status": booking.status,
        "starts_at": booking.starts_at.isoformat(),
        "ends_at": booking.ends_at.isoformat(),
        "hold_expires_at": booking.hold_expires_at.isoformat() if booking.hold_expires_at else None,
        "customer_name": booking.customer_name,
        "customer_contact": booking.customer_contact,
        "identity_status": booking.identity_status,
        "estimated_until": request_sla(booking)["deadline"],
        "items": [{"id": line.article_id, "name": line.article.name,
                   "title": catalog_title(line.article.name, line.article.kind, line.article.brand, line.article.key_spec), "quantity": line.quantity,
                   "auto_added": line.auto_added}
                  for line in booking.lines],
    }


class BookingLineRequest(BaseModel):
    article_id: int
    quantity: int = Field(ge=1, le=30)


class BookingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    start: datetime
    end: datetime
    lines: list[BookingLineRequest] = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1, max_length=200)
    contact: str = Field(min_length=1, max_length=200)
    expected_total: Decimal | None = Field(default=None, ge=0)

    @field_validator("contact")
    @classmethod
    def validate_contact(cls, value):
        return validate_contact_value(value)


def validate_contact_value(value):
    value = value.strip()
    phone = bool(re.fullmatch(r"\+?[0-9](?:[0-9 ()-]*[0-9])?", value)) and 10 <= len(re.sub(r"\D", "", value)) <= 15
    username = value.removeprefix("@")
    telegram = bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", username))
    if not phone and not telegram:
        raise ValueError("Укажите телефон (10–15 цифр) или Telegram username (5–32 символа: латиница, цифры, _)")
    return value


class BookingContactUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    contact: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Укажите имя для заявки")
        return value

    @field_validator("contact")
    @classmethod
    def validate_contact(cls, value):
        return validate_contact_value(value)


async def notify_new_booking(booking_id: int, customer_id: int):
    booking = await asyncio.to_thread(get_booking, booking_id)
    number = booking.human_number or f"№{booking_id}"
    await notify(booking_id, customer_id, "booking_created_customer",
                 f"<b>Заявка {number} создана</b>\n<i>Ожидает решения оператора.</i> Заявка остаётся в очереди до подтверждения или отмены.")


async def notify_cancelled_booking(booking_id: int):
    # Status changes are visible in the activity history, not operator pushes.
    return None


async def notify_booking_status(booking_id: int, customer_id: int, status: str, operator: str):
    return None


async def notify_identity_submitted(booking_id: int):
    """Tell operators that identity data was submitted or corrected; never include PII."""
    booking = await asyncio.to_thread(get_booking, booking_id)
    if not booking or not booking.assignee_id:
        return
    number = getattr(booking, "human_number", None) or f"№{booking_id}"
    message = f"<b>Анкета обновлена · заявка {number}</b>\nПроверьте документы клиента в Mini App."
    await notify_actionable(booking_id, booking.assignee_id, "identity_submitted", message)


@router.get("/miniapp")
def miniapp_page():
    return HTMLResponse(miniapp_html(), headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


def miniapp_html():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8").replace("__APP_VERSION__", __version__)


@router.get("/calendar/{token}.ics")
def calendar_feed(token: str):
    return _calendar_feed_response(token)


@router.get("/calendar.ics")
def calendar_feed_query(token: str = Query(min_length=1, max_length=512)):
    return _calendar_feed_response(token)


def _calendar_feed_response(token: str):
    expected = os.getenv("ICAL_TOKEN", "")
    if not expected or not hmac.compare_digest(token, expected):
        raise HTTPException(404)
    calendar = Calendar()
    calendar.add("prodid", "-//PolyRental//Calendar//RU")
    calendar.add("version", "2.0")
    reserving = {"confirmed", "preparing", "ready", "issued", "return_inspection"}
    for booking in list_bookings(limit=None):
        if booking.status not in reserving:
            continue
        event = Event()
        event.add("uid", f"booking-{booking.id}@polyrental")
        equipment = ", ".join(f"{line.article.name} × {line.quantity}" for line in booking.lines)
        event.add("summary", equipment or "Оборудование")
        event.add("dtstart", booking.starts_at)
        event.add("dtend", booking.ends_at)
        calendar.add_component(event)
    return Response(calendar.to_ical(), media_type="text/calendar")


@router.get("/api/miniapp/availability/events")
async def availability_events(user=Depends(require_customer)):
    async def stream():
        queue = subscribe_availability()
        try:
            yield "data: changed\n\n"
            while True:
                try:
                    await asyncio.wait_for(queue.get(), timeout=20)
                    yield "data: changed\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            unsubscribe_availability(queue)
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control":"no-store", "X-Accel-Buffering":"no"})


@router.get("/api/miniapp/availability")
async def equipment_availability(start: datetime = Query(), end: datetime = Query()):
    try:
        validate_interval(start, end, enforce_booking_notice=True)
        items = await asyncio.to_thread(availability, start, end)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    available = [item for item in items if item["available"]]
    return {
        "items": available,
        "all_items": available + [item for item in items if not item["available"]],
        "unavailable_count": len(items) - len(available),
        "unavailable": [{"name": item["name"], "sku": item["sku"], "available_quantity": 0}
                        for item in items if not item["available"]],
        "duration_hours": round((end - start).total_seconds() / 3600, 2),
    }


@router.post("/api/miniapp/bookings", status_code=201)
async def create_customer_booking(payload: BookingRequest, background_tasks: BackgroundTasks, user=Depends(require_customer)):
    try:
        booking_id, created = await asyncio.to_thread(
            create_booking,
            user["id"], payload.name.strip(), payload.contact.strip(), payload.start,
            payload.end, [line.model_dump() for line in payload.lines], str(payload.request_id), None, return_created=True,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ClientBlocked as exc:
        raise HTTPException(403, str(exc)) from exc
    booking = await asyncio.to_thread(get_booking, booking_id)
    if booking is None:
        raise HTTPException(410, "Заявка с этим идентификатором удалена; создайте новую заявку")
    if created:
        background_tasks.add_task(notify_new_booking, booking_id, user["id"])
    return booking_view(booking)


@router.get("/api/miniapp/me")
async def current_role(user=Depends(require_customer)):
    role = role_for(user["id"])
    if role["admin"]:
        audit_admin_access(user["id"], "miniapp")
    return role


class CartLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    article_id: int = Field(gt=0, strict=True)
    quantity: int = Field(ge=1, le=30, strict=True)


class CartUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: str = Field(default="", max_length=16, pattern=r"^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})$")
    end: str = Field(default="", max_length=16, pattern=r"^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})$")
    lines: list[CartLine] = Field(default_factory=list, max_length=30)
    version: int = Field(ge=0, strict=True)

    @field_validator("start", "end")
    @classmethod
    def valid_cart_date(cls, value):
        if value:
            datetime.strptime(value, "%Y-%m-%dT%H:%M")
        return value

    @field_validator("lines")
    @classmethod
    def unique_cart_lines(cls, value):
        if len({line.article_id for line in value}) != len(value):
            raise ValueError("Позиции не должны повторяться")
        return value


@router.get("/api/miniapp/cart")
async def customer_cart(user=Depends(require_customer)):
    return await asyncio.to_thread(get_cart, user["id"])


@router.put("/api/miniapp/cart")
async def update_customer_cart(payload: CartUpdate, user=Depends(require_customer)):
    try:
        return await asyncio.to_thread(put_cart, user["id"], payload.start, payload.end,
                                       [line.model_dump() for line in payload.lines], payload.version)
    except CartConflict as exc:
        raise HTTPException(409, str(exc)) from exc


class SupportQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=3000)
    booking_id: int | None = Field(default=None, gt=0)
    screen: str = Field(pattern="^(profile|booking|request|bot)$")


class SupportReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=3000)


@router.get("/api/miniapp/support/faq")
async def support_faq(user=Depends(require_customer)):
    return {"items": json.loads((Path(__file__).parent / "assets" / "faq.json").read_text(encoding="utf-8"))}


async def notify_support_owner(owner_id: int, thread_id: int, number: str):
    await notify_actionable(None, owner_id, "support_action", f"Новое обращение №{thread_id}" + (f" · заявка {number}" if number else "") + ". Откройте поддержку в Mini App.")


@router.post("/api/miniapp/support/questions")
async def support_question(payload: SupportQuestion, tasks: BackgroundTasks, user=Depends(require_customer)):
    try:
        result = await asyncio.to_thread(submit_question, user["id"], payload.booking_id, payload.screen, payload.question)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(503, str(exc)) from exc
    if result["owner_id"]:
        tasks.add_task(notify_support_owner, result["owner_id"], result["id"], result["request_number"])
    return {"status": "Обращение получено", "id": result["id"]}


@router.get("/api/miniapp/support/threads")
async def customer_support_threads(user=Depends(require_customer)):
    rows = await asyncio.to_thread(list_support_threads, customer_id=user["id"])
    return {"items": [{"id": row["id"], "request_number": row["request_number"], "status": row["customer_state"]} for row in rows]}


@router.get("/api/miniapp/admin/support")
async def admin_support_threads(user=Depends(require_admin)):
    return {"items": await asyncio.to_thread(list_support_threads)}


@router.post("/api/miniapp/admin/support/{thread_id}/claim")
async def admin_claim_support(thread_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(claim_thread, thread_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except SupportConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "in_progress"}


@router.get("/api/miniapp/admin/support/{thread_id}/messages")
async def admin_support_messages(thread_id: int, user=Depends(require_pii_admin)):
    try:
        return await asyncio.to_thread(read_support_messages, thread_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except SupportConflict as exc:
        raise HTTPException(403, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(503, str(exc)) from exc


@router.post("/api/miniapp/admin/support/{thread_id}/reply")
async def admin_support_reply(thread_id: int, payload: SupportReply, tasks: BackgroundTasks, user=Depends(require_pii_admin)):
    try:
        message_id = await asyncio.to_thread(support_reply, thread_id, user["id"], payload.text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except SupportConflict as exc:
        raise HTTPException(403, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(503, str(exc)) from exc
    tasks.add_task(deliver_reply, message_id)
    return {"status": "queued"}


@router.post("/api/miniapp/admin/support/{thread_id}/resolve")
async def admin_resolve_support(thread_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(resolve_thread, thread_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except SupportConflict as exc:
        raise HTTPException(403, str(exc)) from exc
    return {"status": "resolved"}


class ClientBlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    blocked: bool = Field(strict=True)


@router.put("/api/miniapp/admin/clients/{customer_id}/booking-block")
async def admin_set_client_booking_block(customer_id: int, payload: ClientBlockRequest, user=Depends(require_system_admin)):
    if customer_id <= 0:
        raise HTTPException(422, "Неверный Telegram ID")
    await asyncio.to_thread(set_client_block, customer_id, user["id"], payload.blocked)
    return {"blocked": payload.blocked}


@router.get("/api/miniapp/profile")
async def client_profile(user=Depends(require_customer)):
    state = await asyncio.to_thread(profile_state, user["id"])
    role = role_for(user["id"])
    return {**state, "display_name": operator_name(user), "system_admin": user["id"] in configured_ids("ADMIN_IDS"),
            "start_screen": "management" if role["admin"] else ("booking" if state["client_allowed"] else "blocked")}


class ReminderPreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)


@router.put("/api/miniapp/profile/reminders")
async def update_reminder_preference(payload: ReminderPreference, user=Depends(require_customer)):
    await asyncio.to_thread(set_reminders_enabled, user["id"], payload.enabled)
    return {"enabled": payload.enabled}


@router.post("/api/miniapp/onboarding/show")
async def show_onboarding(user=Depends(require_customer)):
    return {"first_show": await asyncio.to_thread(mark_onboarding_shown, user["id"])}


@router.post("/api/miniapp/onboarding/complete")
async def finish_onboarding(user=Depends(require_customer)):
    await asyncio.to_thread(complete_onboarding, user["id"])
    return {"status": "ok"}


@router.post("/api/miniapp/operator/client-mode")
async def operator_client_mode(user=Depends(require_admin)):
    await asyncio.to_thread(record_client_mode, user["id"])
    return {"status": "ok"}


@router.get("/api/miniapp/bookings")
async def customer_bookings(user=Depends(require_customer)):
    bookings = await asyncio.to_thread(list_customer_bookings, user["id"])
    return {"items": [booking_view(booking) for booking in bookings]}


@router.get("/api/miniapp/profile/history")
async def client_history(category: str = Query(default="active", pattern="^(active|completed|cancelled|all)$"),
                         page: int = Query(default=0, ge=0, le=100000), number: str = Query(default="", max_length=32), user=Depends(require_customer)):
    try:
        bookings, total = await asyncio.to_thread(customer_history_page, user["id"], category, page, 10, number)
    except ValueError as exc:
        raise HTTPException(422, "Введите полный номер заявки или последние четыре цифры") from exc
    with Session() as session:
        available = set(session.scalars(select(ReceiptArchive.booking_id).join(
            BookingDocument, and_(BookingDocument.booking_id == ReceiptArchive.booking_id,
                                 BookingDocument.kind == "receipt_pdf")).where(
            ReceiptArchive.booking_id.in_([booking.id for booking in bookings]),
            ReceiptArchive.expired_at.is_(None), ReceiptArchive.expires_at > func.now())).all())
    return {"items": [booking_view(booking) | {"receipt_available": booking.id in available} for booking in bookings],
            "total": total, "page": page, "page_size": 10}


@router.get("/api/miniapp/bookings/{booking_id}/receipt")
async def customer_download_receipt(booking_id: int, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_receipt")
    try:
        body, filename = await asyncio.to_thread(customer_receipt_pdf, booking_id, user["id"])
        return Response(body, media_type="application/pdf", headers={"Cache-Control": "no-store",
                        "Content-Disposition": f'attachment; filename="{filename}"'})
    except ReceiptExpired as exc:
        raise HTTPException(410, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/api/miniapp/bookings/{booking_id}/receipt/download-link")
async def customer_receipt_download_link(booking_id: int, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_receipt")
    public_url = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    if not public_url.startswith("https://"):
        raise HTTPException(503, "Защищённая загрузка документов временно недоступна")
    try:
        _, filename = await asyncio.to_thread(customer_receipt_pdf, booking_id, user["id"])
    except ReceiptExpired as exc:
        raise HTTPException(410, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    current = time.monotonic()
    for token, (_, _, _, expires_at) in list(_DOCUMENT_DOWNLOAD_TOKENS.items()):
        if expires_at <= current:
            _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
    if len(_DOCUMENT_DOWNLOAD_TOKENS) >= 10000:
        raise HTTPException(503, "Загрузка документов временно недоступна")
    token = secrets.token_urlsafe(32)
    _DOCUMENT_DOWNLOAD_TOKENS[token] = (booking_id, "customer_receipt_pdf", user["id"], current + 120)
    return {"url": f"{public_url}/api/miniapp/document-download/{token}", "file_name": filename}


@router.patch("/api/miniapp/bookings/{booking_id}/contact")
async def customer_update_booking_contact(booking_id: int, payload: BookingContactUpdate,
                                         user=Depends(require_customer)):
    try:
        await asyncio.to_thread(update_booking_contact, booking_id, user["id"],
                                payload.name, payload.contact)
        return {"status": "updated"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/miniapp/bookings/{booking_id}/cancel")
async def cancel_customer_booking(booking_id: int, background_tasks: BackgroundTasks, user=Depends(require_customer)):
    try:
        await asyncio.to_thread(transition, booking_id, "cancelled", user["id"], user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    booking = await asyncio.to_thread(get_booking, booking_id)
    if booking.status == "cancelled":
        background_tasks.add_task(notify_cancelled_booking, booking_id)
    return booking_view(booking)


@router.get("/api/miniapp/privacy-consent")
async def privacy_consent(user=Depends(require_customer)):
    try:
        body = consent_text()
    except Conflict as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"text": body, "version": os.environ["PRIVACY_POLICY_VERSION"],
            "text_hash": hashlib.sha256(body.encode()).hexdigest()}


class AddressSuggestionRequest(BaseModel):
    query: str = Field(min_length=3, max_length=300)


async def _dadata_address_suggestions(query, token):
    async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
        response = await client.post(
            "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address",
            headers={"Authorization": f"Token {token}", "Accept": "application/json",
                     "Content-Type": "application/json"},
            json={"query": query, "count": 7},
        )
    response.raise_for_status()
    result = response.json()
    suggestions = result.get("suggestions", []) if isinstance(result, dict) else []
    if not isinstance(suggestions, list):
        return []
    return [{"value": item.get("value", ""),
             "address": item.get("unrestricted_value") or item.get("value", "")}
            for item in suggestions if isinstance(item, dict) and isinstance(item.get("value"), str) and item.get("value")]


@router.post("/api/miniapp/address-suggestions")
async def address_suggestions(payload: AddressSuggestionRequest, user=Depends(require_customer)):
    _limit_pii(user["id"], "address_suggest", 30, 60)
    token = os.getenv("DADATA_API_KEY", "").strip()
    if not token:
        raise HTTPException(503, "Поиск адреса временно недоступен. Введите адрес вручную")
    try:
        return {"items": await _dadata_address_suggestions(payload.query, token)}
    except (httpx.HTTPError, ValueError):
        # Never include the request, response body or token in logs/errors.
        raise HTTPException(503, "Не удалось получить подсказки адреса. Введите адрес вручную") from None


@router.get("/api/miniapp/universities")
async def universities(user=Depends(require_customer)):
    return {"items": SAINT_PETERSBURG_UNIVERSITIES}


@router.get("/api/miniapp/bookings/{booking_id}/identity")
async def customer_identity_status(booking_id: int, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_read", 20)
    try:
        return await asyncio.to_thread(identity_status, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/api/miniapp/bookings/{booking_id}/identity/reusable-profile")
async def customer_reusable_identity_profile(booking_id: int, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_read", 20)
    try:
        return await asyncio.to_thread(reusable_identity_fields, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/api/miniapp/bookings/{booking_id}/identity/reusable-profile/documents/{kind}")
async def customer_reusable_identity_document(booking_id: int, kind: str, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_read", 20)
    try:
        body, media_type = await asyncio.to_thread(
            reusable_identity_document, booking_id, user["id"], kind)
        return Response(body, media_type=media_type, headers={"Cache-Control": "no-store"})
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/api/miniapp/bookings/{booking_id}/identity")
async def customer_identity_submit(
    booking_id: int,
    background_tasks: BackgroundTasks,
    payload: str = Form(),
    policy_version: str = Form(default=""),
    text_hash: str = Form(default=""),
    passport_main: UploadFile | None = File(None),
    passport_registration: UploadFile | None = File(None),
    student_front: UploadFile | None = File(None),
    user=Depends(require_customer),
):
    _limit_pii(user["id"], "customer_submit", 5, 300)
    try:
        fields = json.loads(payload)
        current = await asyncio.to_thread(identity_status, booking_id, user["id"])
        legacy_institution = (current.get("fields") or {}).get("student_institution") if current.get("status") == "needs_changes" else None
        fields = validate_identity_payload(fields, legacy_institution=legacy_institution)
        uploads = {
            "passport_main": passport_main, "passport_registration": passport_registration,
            "student_front": student_front,
        }
        documents = {}
        for kind, upload in uploads.items():
            if upload is None:
                continue
            raw = await upload.read(8 * 1024 * 1024 + 1)
            try:
                documents[kind] = await asyncio.to_thread(sanitize_image, raw, upload.content_type or "")
            except ValueError as exc:
                raise HTTPException(422, {"field": kind, "message": str(exc)}) from exc
        photo_order = ("passport_main", "passport_registration", "student_front")
        if current["status"] != "needs_changes":
            for kind in photo_order:
                if kind not in documents:
                    label = {"passport_main": "паспорт — страница с фото",
                             "passport_registration": "паспорт — страница регистрации",
                             "student_front": "студенческий — лицевая сторона"}[kind]
                    raise HTTPException(422, {"field": kind, "message": f"Загрузите фото: {label}"})
        else:
            required_photos = set(current.get("review_fields", [])) & DOCUMENT_KINDS
            for kind in photo_order:
                if kind in required_photos and kind not in documents:
                    label = {"passport_main": "паспорт — страница с фото",
                             "passport_registration": "паспорт — страница регистрации",
                             "student_front": "студенческий — лицевая сторона"}[kind]
                    raise HTTPException(422, {"field": kind, "message": f"Загрузите новое фото: {label}"})
        await asyncio.to_thread(submit_identity, booking_id, user["id"], fields, documents,
                                policy_version, text_hash)
        background_tasks.add_task(notify_identity_submitted, booking_id)
        return {"status": "submitted"}
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "Неверный формат анкеты") from exc
    except IdentityFieldError as exc:
        raise HTTPException(422, {"field": exc.field, "message": str(exc)}) from exc
    except ValueError as exc:
        if any(word in str(exc).lower() for word in ("фотограф", "изображен")):
            raise HTTPException(422, {"field": "passport_main", "message": str(exc)}) from exc
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


def admin_booking_view(booking):
    result = booking_view(booking)
    result["assignee_id"] = booking.assignee_id
    result["sla"] = request_sla(booking)
    ordered_assets = sorted(booking.assets, key=lambda row: (
        row.equipment.storage_location or "", row.equipment.article.name if row.equipment.article else row.equipment.name,
        row.equipment.inventory_number))
    result["assets"] = [{"id": asset.equipment.id,
                         "serial": asset.equipment.inventory_number,
                         "article_id": asset.equipment.article_id,
                         "name": catalog_title(asset.equipment.article.name, asset.equipment.article.kind, asset.equipment.article.brand, asset.equipment.article.key_spec) if asset.equipment.article else asset.equipment.name,
                         "location": asset.equipment.storage_location,
                         "inspection_profile": asset.equipment.article.inspection_profile if asset.equipment.article else "generic"}
                        for asset in ordered_assets]
    result["pick_list"] = result["assets"]
    result["inspections"] = [{"equipment_id": inspection.equipment_id, "stage": inspection.stage,
                              "result": inspection.result, "notes": inspection.notes,
                              "defect": inspection.defect, "estimated_cost": str(inspection.estimated_cost),
                              "charge_customer": inspection.charge_customer,
                              "created_at": inspection.created_at.isoformat() if inspection.created_at else None}
                             for inspection in booking.inspections
                             if inspection.stage != "check_in" or booking.inspection_cycle_started_at is None
                             or (inspection.created_at is not None and inspection.created_at >= booking.inspection_cycle_started_at)]
    result["act_signed_at"] = booking.act_signed_at.isoformat() if booking.act_signed_at else None
    with Session() as session:
        result["archived_documents"] = session.scalars(select(BookingDocument.kind).where(
            BookingDocument.booking_id == booking.id)).all()
        threads = session.scalars(select(SupportThread).where(SupportThread.booking_id == booking.id,
                                      SupportThread.status != "resolved")).all()
        pending_support = sum(1 for thread in threads if session.scalar(
            select(SupportMessage.direction).where(SupportMessage.thread_id == thread.id)
            .order_by(SupportMessage.id.desc()).limit(1)) == "client")
        result["actionable_count"] = pending_support + (1 if booking.identity_status == "submitted" else 0)
    result["lines"] = [{"id": line.id, "article_id": line.article_id,
                         "name": line.article.name,
                         "title": catalog_title(line.article.name, line.article.kind, line.article.brand, line.article.key_spec), "quantity": line.quantity}
                        for line in booking.lines]
    return result


@router.get("/api/miniapp/admin/bookings")
async def admin_bookings(user=Depends(require_admin)):
    bookings, leases = await asyncio.gather(asyncio.to_thread(list_bookings),
                                            asyncio.to_thread(operation_lease_states))
    items = []
    for booking in bookings:
        state = leases.get(booking.id)
        # Reads may straddle another operator's transition; never show a claim
        # from a different stage alongside this request snapshot.
        if state and state["stage"] != booking.status:
            state = None
        active = ({key: value for key, value in state.items() if key != "expired"}
                  if state and not state["expired"] else None)
        items.append(admin_booking_view(booking) | {"operation_lease": active,
                                                   "operation_lease_state": state})
    return {"items": items, "undo_seconds": deletion_undo_seconds()}


@router.get("/api/miniapp/admin/bookings/{booking_id}/history")
async def admin_booking_history(booking_id: int, user=Depends(require_admin)):
    try:
        return {"items": await asyncio.to_thread(booking_history, booking_id)}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


class ReassignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignee_id: int = Field(gt=0)


class OperatorQuietHours(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quiet_start: str | None = Field(default=None, max_length=5)
    quiet_end: str | None = Field(default=None, max_length=5)


@router.get("/api/miniapp/admin/notification-preferences")
async def get_operator_preferences(user=Depends(require_admin)):
    return await asyncio.to_thread(operator_preferences, user["id"])


@router.put("/api/miniapp/admin/notification-preferences")
async def update_operator_preferences(payload: OperatorQuietHours, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(save_operator_preferences, user["id"], payload.quiet_start, payload.quiet_end)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await asyncio.to_thread(operator_preferences, user["id"])


@router.put("/api/miniapp/admin/bookings/{booking_id}/assignee")
async def admin_reassign_booking(booking_id: int, payload: ReassignRequest, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(reassign_booking, booking_id, user["id"], payload.assignee_id)
        return admin_booking_view(await asyncio.to_thread(get_booking, booking_id))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/api/miniapp/admin/support/{thread_id}/owner")
async def admin_reassign_support(thread_id: int, payload: ReassignRequest, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(reassign_thread, thread_id, user["id"], payload.assignee_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except SupportConflict as exc:
        raise HTTPException(403, str(exc)) from exc
    return {"status": "ok"}


@router.post("/api/miniapp/admin/bookings/{booking_id}/operation")
async def admin_claim_operation(booking_id: int, user=Depends(require_admin)):
    try:
        return await asyncio.to_thread(claim_booking_operation, booking_id, user["id"], operator_name(user))
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.delete("/api/miniapp/admin/bookings/{booking_id}/operation")
async def admin_release_operation(booking_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(release_booking_operation, booking_id, user["id"])
        return {"status": "released"}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/api/miniapp/admin/calendar-feed")
async def admin_calendar_feed(user=Depends(require_admin)):
    public_url = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    token = os.getenv("ICAL_TOKEN", "").strip()
    if not public_url.startswith("https://") or not token:
        raise HTTPException(503, "Подписка календаря не настроена")
    return {"url": f"{public_url}/calendar.ics?{urlencode({'token': token})}"}


class DeletionIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    target_type: str = Field(pattern="^(request|line|asset)$")
    target_id: int | None = Field(default=None, gt=0)


@router.post("/api/miniapp/admin/bookings/{booking_id}/deletion-intents")
async def admin_prepare_deletion(booking_id: int, payload: DeletionIntentRequest, user=Depends(require_admin)):
    try:
        result = await asyncio.to_thread(create_deletion_intent, booking_id, user["id"], str(payload.id), payload.target_type, payload.target_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return result


@router.post("/api/miniapp/admin/bookings/{booking_id}/deletion-intents/{intent_id}/cancel")
async def admin_cancel_deletion(booking_id: int, intent_id: UUID, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(cancel_deletion_intent, booking_id, user["id"], str(intent_id))
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "cancelled"}


@router.delete("/api/miniapp/admin/bookings/{booking_id}")
async def admin_delete_booking(booking_id: int, intent_id: UUID | None = Query(default=None, alias="intent"), replacement_id: UUID | None = Query(default=None, alias="replacement"), user=Depends(require_admin)):
    try:
        if intent_id is None:
            scheduled = await asyncio.to_thread(schedule_legacy_deletion, booking_id, user["id"], "request", None)
            return {"status": "deleted", "booking_id": booking_id, "intent_id": scheduled}
        await asyncio.to_thread(delete_booking, booking_id, user["id"], str(intent_id) if intent_id else None, str(replacement_id) if replacement_id else None)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    for token, claim in list(_DOCUMENT_DOWNLOAD_TOKENS.items()):
        if claim[0] == booking_id:
            _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
    return {"status": "deleted", "booking_id": booking_id}


@router.post("/api/miniapp/admin/bookings/{booking_id}/restore")
async def admin_restore_booking(booking_id: int, user=Depends(require_system_admin)):
    try:
        await asyncio.to_thread(restore_booking, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "restored", "booking_id": booking_id}


@router.delete("/api/miniapp/admin/bookings/{booking_id}/lines/{line_id}")
async def admin_delete_booking_line(booking_id: int, line_id: int, intent_id: UUID | None = Query(default=None, alias="intent"), replacement_id: UUID | None = Query(default=None, alias="replacement"), user=Depends(require_admin)):
    try:
        if intent_id is None:
            scheduled = await asyncio.to_thread(schedule_legacy_deletion, booking_id, user["id"], "line", line_id)
            return {"status": "deleted", "intent_id": scheduled}
        await asyncio.to_thread(set_booking_line_deleted, booking_id, line_id, user["id"], True, str(intent_id) if intent_id else None, str(replacement_id) if replacement_id else None)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "deleted"}


@router.post("/api/miniapp/admin/bookings/{booking_id}/lines/{line_id}/restore")
async def admin_restore_booking_line(booking_id: int, line_id: int, user=Depends(require_system_admin)):
    try:
        await asyncio.to_thread(set_booking_line_deleted, booking_id, line_id, user["id"], False)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "restored"}


@router.delete("/api/miniapp/admin/bookings/{booking_id}/assets/{equipment_id}")
async def admin_delete_booking_asset(booking_id: int, equipment_id: int, intent_id: UUID | None = Query(default=None, alias="intent"), replacement_id: UUID | None = Query(default=None, alias="replacement"), user=Depends(require_admin)):
    try:
        if intent_id is None:
            scheduled = await asyncio.to_thread(schedule_legacy_deletion, booking_id, user["id"], "asset", equipment_id)
            return {"status": "deleted", "intent_id": scheduled}
        await asyncio.to_thread(set_booking_asset_deleted, booking_id, equipment_id, user["id"], True, str(intent_id) if intent_id else None, str(replacement_id) if replacement_id else None)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "deleted"}


@router.post("/api/miniapp/admin/bookings/{booking_id}/assets/{equipment_id}/restore")
async def admin_restore_booking_asset(booking_id: int, equipment_id: int, user=Depends(require_system_admin)):
    try:
        await asyncio.to_thread(set_booking_asset_deleted, booking_id, equipment_id, user["id"], False)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "restored"}


class TestFlagRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_test: bool = Field(strict=True)


@router.put("/api/miniapp/admin/bookings/{booking_id}/test-flag")
async def admin_set_booking_test_flag(booking_id: int, payload: TestFlagRequest, user=Depends(require_system_admin)):
    try:
        await asyncio.to_thread(set_booking_test_flag, booking_id, user["id"], payload.is_test)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"is_test": payload.is_test}


@router.put("/api/miniapp/admin/catalog/articles/{article_id}/test-flag")
async def admin_set_article_test_flag(article_id: int, payload: TestFlagRequest, user=Depends(require_system_admin)):
    try:
        await asyncio.to_thread(set_article_test_flag, article_id, user["id"], payload.is_test)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"is_test": payload.is_test}


@router.post("/api/miniapp/admin/bookings/{booking_id}/hide-test")
async def admin_hide_test_booking(booking_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(hide_test_booking, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "hidden"}


@router.get("/api/miniapp/admin/hidden-test-bookings")
async def admin_hidden_test_bookings(user=Depends(require_system_admin)):
    bookings = await asyncio.to_thread(list_hidden_test_bookings)
    return {"items": [{"id": booking.id, "human_number": booking.human_number,
                       "status": booking.status, "created_at": booking.created_at.isoformat()} for booking in bookings]}


@router.get("/api/miniapp/admin/catalog")
async def admin_catalog(user=Depends(require_admin)):
    articles = await asyncio.to_thread(list_articles)
    dependencies = await asyncio.to_thread(list_dependencies)
    return {"articles": [{"id": article.id, "sku": article.sku, "name": article.name,
                           "is_test": article.is_test,
                           "title": catalog_title(article.name, article.kind, article.brand, article.key_spec),
                           "kind": article.kind, "brand": article.brand, "key_spec": article.key_spec,
                           "category": article.category,
                           "description": article.description,
                           "composition": article.composition or "",
                           "inspection_profile": article.inspection_profile,
                           "image_url": article.image_url,
                           "active": article.is_active,
                           "buffer_hours": article.buffer_hours,
                           "equipment": [{"id": asset.id, "serial": asset.serial_number or "",
                                          "asset_code": asset.inventory_number,
                                          "inventory_code": asset.asset_inventory_code or "",
                                          "condition": asset.condition, "location": asset.storage_location,
                                          "health": asset.health_percent, "charge": asset.charge_percent}
                                         for asset in article.equipment]}
                          for article in articles],
            "dependencies": [{"parent_article_id": item.parent_article_id,
                               "child_article_id": item.child_article_id,
                               "quantity": item.quantity, "billable": item.billable}
                              for item in dependencies]}


@router.post("/api/miniapp/admin/catalog/import-csv")
async def admin_import_catalog_csv(file: UploadFile = File(...), user=Depends(require_admin)):
    data = await file.read(MAX_CSV_BYTES + 1)
    await file.close()
    try:
        return await asyncio.to_thread(import_catalog_csv, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(409, "Артикул или серийный номер уже добавлен другим оператором") from exc


class ArticleRequest(BaseModel):
    id: int | None = None
    sku: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    kind: str | None = Field(default=None, max_length=80)
    brand: str | None = Field(default=None, max_length=100)
    key_spec: str | None = Field(default=None, max_length=120)
    description: str = Field(default="", max_length=4000)
    composition: str = Field(default="", max_length=4000)
    rate: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    category: str = Field(default="generic", max_length=40)
    inspection_profile: str = Field(default="generic", max_length=30)
    buffer_hours: int = Field(default=24, ge=0, le=168)
    image_url: str = Field(default="", max_length=500)
    active: bool = True


@router.post("/api/miniapp/admin/catalog/articles")
async def admin_save_article(payload: ArticleRequest, user=Depends(require_admin)):
    try:
        article_id = await asyncio.to_thread(
            save_article, payload.sku, payload.name, payload.description, Decimal("0"),
            payload.category, payload.inspection_profile, payload.buffer_hours,
            payload.image_url, payload.id, payload.active, payload.composition,
            payload.kind, payload.brand, payload.key_spec, user["id"])
        return {"id": article_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Артикул с таким SKU уже существует") from exc
    except (ValueError, Conflict) as exc:
        raise HTTPException(422, str(exc)) from exc


class EquipmentRequest(BaseModel):
    id: int | None = None
    article_id: int
    serial: str = Field(default="", max_length=80)
    inventory_code: str = Field(default="", max_length=80)
    condition: str = "available"
    location: str = Field(default="", max_length=120)
    health: int | None = Field(default=None, ge=0, le=100)
    charge: int | None = Field(default=None, ge=0, le=100)


@router.post("/api/miniapp/admin/catalog/equipment")
async def admin_save_equipment(payload: EquipmentRequest, user=Depends(require_admin)):
    try:
        equipment_id = await asyncio.to_thread(
            save_equipment, "", "", "", 0, payload.condition, payload.id,
            None, payload.article_id, payload.location, payload.health, payload.charge,
            payload.serial, payload.inventory_code)
        return {"id": equipment_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Экземпляр с таким инвентарным кодом уже существует") from exc
    except (ValueError, Conflict) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/api/miniapp/admin/catalog/equipment/{equipment_id}")
async def admin_delete_equipment(equipment_id: int, user=Depends(require_admin)):
    try:
        return await asyncio.to_thread(delete_equipment, equipment_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


class DependencyRequest(BaseModel):
    parent_article_id: int
    child_article_id: int
    quantity: int = Field(default=1, ge=1, le=30)
    billable: bool = False


@router.put("/api/miniapp/admin/catalog/dependencies")
async def admin_save_dependency(payload: DependencyRequest, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(save_dependency, payload.parent_article_id,
                                payload.child_article_id, payload.quantity, payload.billable)
        return {"status": "saved"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/api/miniapp/admin/catalog/dependencies/{parent_id}/{child_id}")
async def admin_delete_dependency(parent_id: int, child_id: int, user=Depends(require_admin)):
    await asyncio.to_thread(delete_dependency, parent_id, child_id)
    return {"status": "deleted"}


class TransitionRequest(BaseModel):
    action: str


class ReworkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: str
    comment: str = Field(min_length=1, max_length=2000)


@router.post("/api/miniapp/admin/bookings/{booking_id}/rework")
async def admin_return_for_rework(booking_id: int, payload: ReworkRequest,
                                  background_tasks: BackgroundTasks, user=Depends(require_admin)):
    try:
        status = await asyncio.to_thread(return_for_rework, booking_id, payload.target, payload.comment,
                                         user["id"], operator_name(user))
        booking = await asyncio.to_thread(get_booking, booking_id)
        background_tasks.add_task(notify_booking_status, booking_id, booking.customer_id, status,
                                  operator_name(user))
        return admin_booking_view(booking)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/transition")
async def admin_transition(booking_id: int, payload: TransitionRequest,
                           background_tasks: BackgroundTasks, user=Depends(require_admin)):
    required = "manager" if payload.action == "confirmed" else "operator"
    if not await asyncio.to_thread(staff_allows, user["id"], required):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        status = await asyncio.to_thread(transition, booking_id, payload.action, user["id"],
                                         actor_name=operator_name(user))
        booking = await asyncio.to_thread(get_booking, booking_id)
        background_tasks.add_task(notify_booking_status, booking_id, booking.customer_id, status,
                                  operator_name(user))
        return admin_booking_view(booking) | {"status": status}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


class AssignmentRequest(BaseModel):
    assignments: dict[str, list[int]] = Field(default_factory=dict)


@router.put("/api/miniapp/admin/bookings/{booking_id}/assignments")
async def admin_assign(booking_id: int, payload: AssignmentRequest, user=Depends(require_admin)):
    if not await asyncio.to_thread(staff_allows, user["id"], "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        await asyncio.to_thread(assign_booking_assets, booking_id, user["id"], payload.assignments or None,
                                operator_name(user))
        return admin_booking_view(await asyncio.to_thread(get_booking, booking_id))
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc)) from exc


class InspectionRequest(BaseModel):
    equipment_id: int
    stage: str
    result: str
    checklist: dict[str, bool] = Field(default_factory=dict)
    notes: str = Field(default="", max_length=2000)
    defect: str = Field(default="", max_length=4000)
    estimated_cost: Decimal = Field(default=0, ge=0, max_digits=12, decimal_places=2)
    charge_customer: bool = False


@router.post("/api/miniapp/admin/bookings/{booking_id}/inspection")
async def admin_inspection(booking_id: int, payload: InspectionRequest, user=Depends(require_admin)):
    if not await asyncio.to_thread(staff_allows, user["id"], "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        await asyncio.to_thread(record_inspection, booking_id, payload.equipment_id, payload.stage,
                                payload.result, payload.checklist, payload.notes, user["id"],
                                payload.defect, payload.estimated_cost, payload.charge_customer,
                                operator_name(user))
        return {"status": "saved"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/inspection-photo")
async def admin_inspection_photo(booking_id: int, equipment_id: int = Form(...),
                                photo: UploadFile = File(...), user=Depends(require_admin)):
    if not await asyncio.to_thread(staff_allows, user["id"], "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    raw = await photo.read(8 * 1024 * 1024 + 1)
    try:
        normalized, _ = sanitize_image(raw, photo.content_type or "")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    claimed = False
    saved = False
    try:
        await asyncio.to_thread(claim_booking_operation, booking_id, user["id"], operator_name(user))
        claimed = True
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc)) from exc
    try:
        with Session.begin() as session:
            record = session.scalar(select(Inspection).where(
                Inspection.booking_id == booking_id, Inspection.equipment_id == equipment_id,
                Inspection.stage == "check_in", Inspection.result == "fail").with_for_update())
            if record is None:
                raise HTTPException(409, "Сначала зафиксируйте неисправность при возврате")
            nonce = os.urandom(12)
            aad = f"{booking_id}:{equipment_id}:damage-photo-v1".encode()
            record.encrypted_photo = AESGCM(_master_key()).encrypt(nonce, normalized, aad)
            record.photo_nonce = nonce
            record.photo_sha256 = hashlib.sha256(normalized).hexdigest()
        saved = True
        return {"status": "saved"}
    finally:
        # A rejected upload must not block the return-inspection stage for ten minutes.
        if claimed and not saved:
            await asyncio.to_thread(release_booking_operation, booking_id, user["id"])


@router.post("/api/miniapp/admin/bookings/{booking_id}/act-signed")
async def admin_act_signed(booking_id: int, user=Depends(require_pii_admin)):
    try:
        await asyncio.to_thread(archived_document, booking_id, "issue", user["id"])
        await asyncio.to_thread(archived_document, booking_id, "receipt", user["id"])
        # The irreversible signature marker is written only after both durable copies exist.
        await asyncio.to_thread(mark_act_signed, booking_id, user["id"])
        return {"status": "signed"}
    except (Conflict, ValueError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/api/miniapp/admin/bookings/{booking_id}/identity")
async def admin_identity_masked(booking_id: int, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    try:
        return await asyncio.to_thread(masked_identity, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/identity/reveal")
async def admin_identity_reveal(booking_id: int, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    try:
        return await asyncio.to_thread(reveal_identity, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


class IdentityReviewRequest(BaseModel):
    approved: bool
    comment: str = Field(default="", max_length=500)
    fields: list[str] = Field(default_factory=list, max_length=20)


@router.post("/api/miniapp/admin/bookings/{booking_id}/identity/review")
async def admin_identity_review(booking_id: int, payload: IdentityReviewRequest,
                                background_tasks: BackgroundTasks, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    claimed = False
    try:
        await asyncio.to_thread(claim_booking_operation, booking_id, user["id"], "", "identity_review")
        claimed = True
        await asyncio.to_thread(review_identity, booking_id, user["id"], payload.approved, payload.comment, payload.fields)
        booking = await asyncio.to_thread(get_booking, booking_id)
        background_tasks.add_task(notify_booking_status, booking_id, booking.customer_id,
                                  "identity_verified" if payload.approved else "identity_needs_changes",
                                  operator_name(user))
        return {"status": "verified" if payload.approved else "needs_changes"}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    finally:
        if claimed:
            await asyncio.to_thread(release_booking_operation, booking_id, user["id"], "identity_review")


@router.get("/api/miniapp/admin/bookings/{booking_id}/identity/documents/{kind}")
async def admin_identity_document(booking_id: int, kind: str, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    try:
        data, media_type = await asyncio.to_thread(identity_document, booking_id, kind, user["id"])
        return Response(data, media_type=media_type, headers={"Cache-Control": "no-store",
                        "Content-Disposition": f'attachment; filename="{kind}.jpg"'})
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/api/miniapp/admin/bookings/{booking_id}/documents/{kind}")
async def admin_generated_document(booking_id: int, kind: str, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    if kind not in {"issue", "receipt"}:
        raise HTTPException(404, "Документ не найден")
    try:
        body, filename = await asyncio.to_thread(operator_document, booking_id, kind, user["id"])
        return Response(body, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Cache-Control": "no-store",
                                 "Content-Disposition": f'attachment; filename="{filename}"'})
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/documents/{kind}/download-link")
async def admin_generated_document_download_link(booking_id: int, kind: str, user=Depends(require_pii_admin)):
    if kind not in {"issue", "receipt"}:
        raise HTTPException(404, "Документ не найден")
    _limit_pii(user["id"], "admin_document_download", 20)
    public_url = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    if not public_url.startswith("https://"):
        raise HTTPException(503, "Защищённая загрузка документов временно недоступна")
    current = time.monotonic()
    for token, (_, _, _, expires_at) in list(_DOCUMENT_DOWNLOAD_TOKENS.items()):
        if expires_at <= current:
            _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
    if len(_DOCUMENT_DOWNLOAD_TOKENS) >= 10000:
        raise HTTPException(503, "Загрузка документов временно недоступна")
    booking = await asyncio.to_thread(get_booking, booking_id)
    if booking is None:
        raise HTTPException(404, "Заявка не найдена")
    token = secrets.token_urlsafe(32)
    _DOCUMENT_DOWNLOAD_TOKENS[token] = (booking_id, kind, user["id"], current + 120)
    public_id = (booking.human_number or "request").replace("ТС", "TS")
    filename = f"{'act' if kind == 'issue' else 'receipt'}-{public_id}.docx"
    return {"url": f"{public_url}/api/miniapp/document-download/{token}", "file_name": filename}


@router.get("/api/miniapp/document-download/{token}")
async def download_generated_document(token: str):
    claim = _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
    if claim is None:
        raise HTTPException(404, "Ссылка на документ недействительна или уже использована")
    booking_id, kind, actor_id, expires_at = claim
    if expires_at <= time.monotonic():
        raise HTTPException(404, "Срок действия ссылки истёк. Запросите документ повторно")
    try:
        if kind == "customer_receipt_pdf":
            body, filename = await asyncio.to_thread(customer_receipt_pdf, booking_id, actor_id)
            media_type = "application/pdf"
        else:
            body, filename = await asyncio.to_thread(operator_document, booking_id, kind, actor_id)
            media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return Response(body, media_type=media_type,
                        headers={"Cache-Control": "no-store, max-age=0",
                                 "Content-Disposition": f'attachment; filename="{filename}"',
                                 "Access-Control-Allow-Origin": "https://web.telegram.org",
                                 "Access-Control-Expose-Headers": "Content-Disposition",
                                 "Vary": "Origin"})
    except ReceiptExpired as exc:
        raise HTTPException(410, str(exc)) from exc
    except (ValueError, Conflict) as exc:
        raise HTTPException(404 if kind == "customer_receipt_pdf" else 409, str(exc)) from exc


@router.get("/api/miniapp/admin/repairs")
async def admin_repairs(user=Depends(require_admin)):
    repairs = await asyncio.to_thread(list_repairs)
    return {"items": [{"id": ticket.id, "booking_id": ticket.booking_id,
                        "serial": ticket.equipment.inventory_number, "status": ticket.status,
                        "defect": ticket.defect, "estimated_cost": str(ticket.estimated_cost),
                        "charge_customer": ticket.charge_customer} for ticket in repairs]}


@router.post("/api/miniapp/admin/repairs/{ticket_id}/close")
async def admin_close_repair(ticket_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(close_repair, ticket_id, user["id"])
        return {"status": "closed"}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


class IdentityOperationRequest(BaseModel):
    operation: str


@router.post("/api/miniapp/admin/bookings/{booking_id}/identity/operation")
async def admin_identity_operation(booking_id: int, payload: IdentityOperationRequest,
                                   user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    try:
        if payload.operation == "block":
            await asyncio.to_thread(block_identity, booking_id, user["id"], True)
        elif payload.operation == "unblock":
            await asyncio.to_thread(block_identity, booking_id, user["id"], False)
        elif payload.operation == "delete":
            await asyncio.to_thread(delete_identity, booking_id, user["id"], "subject_request")
        else:
            raise ValueError("Неизвестная операция")
        return {"status": payload.operation}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
