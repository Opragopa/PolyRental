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
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qsl, urlencode
from uuid import UUID

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form, Header,
                     HTTPException, Query, Request, UploadFile)
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from aiogram.enums import ParseMode
from icalendar import Calendar, Event
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, func, and_, or_, text

from .documents import archived_document, operator_document
from .catalog_import import MAX_CSV_BYTES, import_catalog_csv
from .cart import CartConflict, get_cart, put_cart
from .availability_events import subscribe as subscribe_availability, unsubscribe as unsubscribe_availability
from .catalog_titles import catalog_title
from .catalog_categories import list_categories, create_category, delete_category
from .booking_events import claim_notices
from .request_sla import request_sla
from .support import (SupportConflict, submit_question, list_threads as list_support_threads, support_threads_page,
                      claim_thread, read_messages as read_support_messages, reply as support_reply,
                      resolve_thread, reassign_thread, deliver_reply)
from .client_profile import profile_state, mark_onboarding_shown, complete_onboarding, record_client_mode, set_reminders_enabled, set_client_block
from .booking_messages import booking_status_text
from .notification_outbox import notify, notify_actionable
from .operator_preferences import preferences as operator_preferences, save_preferences as save_operator_preferences
from . import __version__
from .roles import configured_ids, is_staff, role_for, audit_admin_access, staff_allows, staff_subrole
from .db import BookingDocument, Inspection, ReceiptArchive, Session, SupportMessage, SupportThread
from .receipt_archive import ReceiptExpired, customer_receipt_pdf
from .pii import (DOCUMENT_KINDS, IdentityFieldError, _master_key, block_identity, consent_text, delete_identity,
                  identity_document, identity_status, masked_identity, pii_admin_ids,
                  reusable_identity_fields, profile_identity_fields, update_profile_identity,
                  reusable_identity_document,
                  reveal_identity, review_identity, sanitize_image, submit_identity,
                  validate_identity_payload)
from .rental import (ClientBlocked, Conflict, archive_article, assign_booking_assets, availability, availability_page, booking_history, booking_history_page,
                     claim_booking_operation, create_booking, operation_lease_states, nearest_available_period,
                     close_repair, delete_booking, restore_booking, set_booking_line_deleted, set_booking_asset_deleted, create_deletion_intent, cancel_deletion_intent, schedule_legacy_deletion, deletion_undo_seconds, reassign_booking, hide_test_booking, set_booking_test_flag, set_article_test_flag, delete_dependency, delete_equipment, get_booking,
                     list_articles, list_articles_page, list_bookings, admin_booking_page, admin_queue_counts, list_customer_bookings, list_hidden_test_bookings, customer_history_page,
                     list_dependencies, list_equipment, list_repairs, mark_act_signed,
                     record_inspection, release_booking_operation, save_article, save_dependency, save_equipment,
                     transition, update_booking_contact, validate_interval, return_for_rework)
from .universities import SAINT_PETERSBURG_UNIVERSITIES

class PrivateRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def no_store(request):
            try:
                response = await handler(request)
            except PermissionError as exc:
                raise HTTPException(403, str(exc)) from exc
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


def require_customer(request: Request, x_telegram_init_data: str = Header(default="")):
    from .site_auth import site_user
    user = verify_init_data(x_telegram_init_data) if x_telegram_init_data else site_user(request)
    if user is None:
        raise HTTPException(401, "Откройте приложение через Telegram ещё раз")
    return user


def _ids(name):
    return configured_ids(name)


def require_admin(user=Depends(require_customer)):
    if not staff_allows(user["id"], "operator"):
        raise HTTPException(403, "Доступ только для сотрудников")
    return user


@router.post("/api/miniapp/notifications/claim")
async def claim_booking_notifications(user=Depends(require_customer)):
    return {"items": await asyncio.to_thread(claim_notices, user["id"])}


@router.get("/api/miniapp/catalog/categories")
async def catalog_categories():
    from .public_cache import cached_public_value
    return {"items": await asyncio.to_thread(cached_public_value, "categories", {}, list_categories, 300)}


class CategoryRequest(BaseModel):
    parent_code: str | None = None
    icon: str = "equipment"
    name: str = Field(min_length=1, max_length=100)


@router.post("/api/miniapp/admin/catalog/categories")
async def admin_create_category(payload: CategoryRequest, user=Depends(require_admin)):
    try:
        return await asyncio.to_thread(create_category, payload.name, user["id"], payload.parent_code, payload.icon)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/api/miniapp/admin/catalog/categories/{code}")
async def admin_delete_category(code: str, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(delete_category, code, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True}


def require_catalog_manager(user=Depends(require_admin)):
    if not staff_allows(user["id"], "manager"):
        raise HTTPException(403, "Изменять оборудование может только менеджер или администратор")
    return user


def require_system_admin(user=Depends(require_customer)):
    if not staff_allows(user["id"], "admin"):
        raise HTTPException(403, "Доступ только для администратора")
    return user


def operator_name(user):
    name = " ".join(filter(None, [user.get("first_name", ""), user.get("last_name", "")])).strip()
    return name or (f"@{user['username']}" if user.get("username") else f"оператор {user['id']}")


def require_pii_admin(user=Depends(require_customer)):
    if user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Нет доступа к персональным данным")
    return user


def require_signer_staff(user=Depends(require_customer)):
    if not staff_allows(user["id"], "operator"):
        raise HTTPException(403, "Подтверждать бумажную подпись может только доверенный сотрудник")
    return user


def require_support_staff(user=Depends(require_admin)):
    if user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Для работы с обращениями нужен доступ к персональным данным")
    return user


def require_reviewer(user=Depends(require_customer)):
    if not staff_allows(user["id"], "operator") and user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Доступ только для сотрудников")
    return user


def booking_view(booking):
    from .handover import handover_state
    handover = handover_state(booking.id)
    # Customer JSON never includes manufacturer serials or internal asset codes.
    handover = {**handover,
        "snapshot": [{key: value for key, value in row.items() if key != "code"} for row in handover.get("snapshot", [])],
        "exceptions": [{**row, "replacement_name": row.get("replacement_name","") if row.get("component") else row.get("replacement_title", "")} for row in handover.get("exceptions", [])]}
    from .db import BookingChange
    with Session() as session:
        change = session.scalar(select(BookingChange).where(BookingChange.booking_id == booking.id).order_by(BookingChange.id.desc()).limit(1))
        from .db import BookingRework
        rework=session.scalar(select(BookingRework).where(BookingRework.booking_id==booking.id).order_by(BookingRework.id.desc()).limit(1))
    return {
        "rework_available":bool(rework and rework.to_status==booking.status),
        "change_status": change.status if change else None,
        "receipt_preview_available":booking.status=="ready" and bool(handover.get("snapshot")),
        "handover": handover,
        "partial_issue": bool(handover.get("exceptions")),
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
    return None  # The transaction queues the shared event and deliveries.


async def notify_cancelled_booking(booking_id: int):
    # Status changes are visible in the activity history, not operator pushes.
    return None


async def notify_booking_status(booking_id: int, customer_id: int, status: str, operator: str):
    return None  # Includes identity events, persisted with the review transaction.


async def notify_identity_submitted(booking_id: int):
    """Tell operators that identity data was submitted or corrected; never include PII."""
    return None


@router.get("/site")
def site_page(request: Request):
    from .site_auth import site_user
    from fastapi.responses import RedirectResponse
    if not site_user(request):
        return RedirectResponse("/site/login", status_code=303)
    return HTMLResponse(miniapp_html(), headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


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


@router.get("/api/miniapp/catalog")
async def customer_catalog(page: int = Query(default=0, ge=0, le=100000),
                           page_size: int = Query(default=20, ge=1, le=100),
                           q: str = Query(default="", max_length=200),
                           selected: list[int] = Query(default=[]),
                           category: str = Query(default="", max_length=40)):
    try:
        items, selected_items, total = await asyncio.to_thread(
            availability_page, None, None, page, page_size, q, selected, category)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"items": items, "selected_items": selected_items,
            "page": page, "page_size": page_size, "total": total}


@router.get("/api/miniapp/availability")
async def equipment_availability(start: datetime = Query(), end: datetime = Query(),
                                 page: int | None = Query(default=None, ge=0, le=100000),
                                 page_size: int = Query(default=20, ge=1, le=100),
                                 q: str = Query(default="", max_length=200),
                                 selected: list[int] = Query(default=[]),
                                 category: str = Query(default="", max_length=40)):
    try:
        validate_interval(start, end, enforce_booking_notice=True)
        from .public_cache import cached_public_value
        if page is None:
            items = await asyncio.to_thread(cached_public_value, "availability", {"start":start.isoformat(), "end":end.isoformat()},
                                            lambda: availability(start, end), 5)
            selected_items, total = [], len(items)
        else:
            if len(selected) > 30 or any(item <= 0 for item in selected):
                raise ValueError("Выберите не более 30 позиций")
            selected_ids = sorted(set(selected))
            params = {"start":start.isoformat(), "end":end.isoformat(), "page":page, "page_size":page_size, "q":q, "selected":selected_ids, "category":category}
            items, selected_items, total = await asyncio.to_thread(cached_public_value, "availability-page", params,
                lambda: availability_page(start, end, page, page_size, q, selected_ids, category), 5)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    available = [item for item in items if item["available"]]
    return {
        "items": available,
        "all_items": (available + [item for item in items if not item["available"]]) if page is None else items,
        "selected_items": selected_items, "page":page, "page_size":page_size, "total":total,
        "unavailable_count": len(items) - len(available),
        "unavailable": [{"name": item["name"], "sku": item["sku"], "available_quantity": 0}
                        for item in items if not item["available"]],
        "duration_hours": round((end - start).total_seconds() / 3600, 2),
    }


class NearestAvailabilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: datetime
    end: datetime
    lines: list[BookingLineRequest] = Field(min_length=1, max_length=30)


class CalendarAvailabilityRequest(NearestAvailabilityRequest):
    first_day: date


@router.post("/api/miniapp/availability/calendar")
async def booking_calendar_availability(payload: CalendarAvailabilityRequest, user=Depends(require_customer)):
    from .rental import calendar_availability
    try:
        return await asyncio.to_thread(calendar_availability, payload.start, payload.end,
            [line.model_dump() for line in payload.lines], payload.first_day)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/api/miniapp/availability/nearest")
async def nearest_availability(payload: NearestAvailabilityRequest, user=Depends(require_customer)):
    _limit_pii(user["id"], "availability_search", 30)
    try:
        period = await asyncio.to_thread(nearest_available_period, payload.start, payload.end,
                                         [line.model_dump() for line in payload.lines])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"period": period, "horizon_days": 90}


@router.get("/api/miniapp/schedule")
async def handover_schedule():
    from .schedule import schedule_policy
    from .public_cache import cached_public_value
    policy_env = {key: os.getenv(key, "") for key in ("NON_WORKING_DATES", "WORKING_DATES", "ENFORCE_HANDOVER_SCHEDULE")}
    return await asyncio.to_thread(cached_public_value, "schedule", policy_env, schedule_policy, 300, revision=False)


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
    subrole = staff_subrole(user["id"])
    if subrole:
        role["staff_role"] = subrole
        from .db import StaffRole, TrustedSigner
        with Session.begin() as session:
            signer=session.get(TrustedSigner,user["id"])
            staff=session.get(StaffRole,user["id"])
            display = (f"@{user['username']}" if user.get("username") else " ".join(filter(None, [user.get("first_name", ""), user.get("last_name", "")])))[:200]
            if staff and display and staff.display_name != display: staff.display_name = display
            role["trusted_signer"]=bool(signer and signer.active)
    elif role["pii_admin"]:
        role["pii_only"] = True
    role["admin"] = subrole is not None or role["pii_admin"]
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
    screen: str = Field(pattern="^(profile|booking|request|bot|feedback)$")


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
    return {"status": "Спасибо! Мы рассмотрим ваше предложение." if payload.screen == "feedback" else "Обращение получено", "id": result["id"]}


@router.get("/api/miniapp/support/threads")
async def customer_support_threads(page: int | None = Query(default=None, ge=0, le=100000),
                                   page_size: int = Query(default=20, ge=1, le=100), user=Depends(require_customer)):
    if page is None:
        rows = await asyncio.to_thread(list_support_threads, customer_id=user["id"])
        total = len(rows)
    else:
        rows, total = await asyncio.to_thread(support_threads_page, customer_id=user["id"], page=page, page_size=page_size)
    return {"items": [{"id": row["id"], "request_number": row["request_number"], "status": row["customer_state"]} for row in rows], "total":total, "page":page, "page_size":page_size}


@router.get("/api/miniapp/admin/support")
async def admin_support_threads(page: int | None = Query(default=None, ge=0, le=100000),
                                page_size: int = Query(default=20, ge=1, le=100),
                                thread_id: int | None = Query(default=None, gt=0), user=Depends(require_admin)):
    if page is None:
        rows = await asyncio.to_thread(list_support_threads)
        total = len(rows)
    else:
        rows, total = await asyncio.to_thread(support_threads_page, page=page, page_size=page_size, thread_id=thread_id)
    return {"items": rows, "total":total, "page":page, "page_size":page_size, "eligible_owners": sorted(uid for uid in configured_ids("PII_ADMIN_IDS") if staff_allows(uid, "operator"))}


@router.post("/api/miniapp/admin/support/{thread_id}/claim")
async def admin_claim_support(thread_id: int, user=Depends(require_support_staff)):
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
async def admin_resolve_support(thread_id: int, user=Depends(require_support_staff)):
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
    from .db import StaffNavigation
    with Session() as session:
        navigation=session.get(StaffNavigation,user["id"])
    return {**state, "display_name": operator_name(user), "system_admin": staff_allows(user["id"], "admin"),
            "last_section": navigation.section if navigation and staff_subrole(user["id"]) else None,
            "start_screen": "management" if role["admin"] else ("booking" if state["client_allowed"] else "blocked")}


@router.get("/api/miniapp/profile/identity")
async def client_profile_identity(user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_read", 20)
    return await asyncio.to_thread(profile_identity_fields, user["id"])


class ReminderPreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)



@router.put("/api/miniapp/profile/identity")
async def client_update_profile_identity(payload: dict[str, str], user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_identity")
    try:
        return await asyncio.to_thread(update_profile_identity, user["id"], payload)
    except (ValueError, Conflict) as exc:
        raise HTTPException(422, str(exc)) from exc

@router.put("/api/miniapp/profile/reminders")
async def update_reminder_preference(payload: ReminderPreference, user=Depends(require_customer)):
    await asyncio.to_thread(set_reminders_enabled, user["id"], payload.enabled)
    return {"enabled": payload.enabled}


@router.post("/api/miniapp/onboarding/show")
async def show_onboarding(user=Depends(require_customer)):
    return {"first_show": await asyncio.to_thread(mark_onboarding_shown, user["id"])}


@router.get("/api/miniapp/release")
async def latest_release(user=Depends(require_customer)):
    from .release_notes import release_for_user
    staff = await asyncio.to_thread(staff_allows, user["id"], "operator")
    return {"release": await asyncio.to_thread(release_for_user, user["id"], staff)}


class ReleaseSeenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^\d{1,5}\.\d{1,5}\.\d{1,5}$")


@router.post("/api/miniapp/release/seen")
async def acknowledge_release(payload: ReleaseSeenRequest, user=Depends(require_customer)):
    from .release_notes import mark_release_seen
    try:
        await asyncio.to_thread(mark_release_seen, user["id"], payload.version)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "ok"}


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
async def client_history(category: str = Query(default="active", pattern="^(active|completed|all|pending|needs_changes|confirmed|preparing|ready|issued|return_inspection|returned|cancelled|status_cancelled|expired)$"),
                         page: int = Query(default=0, ge=0, le=100000), number: str = Query(default="", max_length=32),
                         booking_id: int | None = Query(default=None, gt=0), sort: str = Query(default="date", pattern="^(date|status)$"), user=Depends(require_customer)):
    try:
        bookings, total = await asyncio.to_thread(customer_history_page, user["id"], category, page, 10, number, booking_id, sort)
    except ValueError as exc:
        raise HTTPException(422, "Введите полный номер заявки или последние четыре цифры") from exc
    with Session() as session:
        available = set(session.scalars(select(BookingDocument.booking_id).outerjoin(
            ReceiptArchive, ReceiptArchive.booking_id == BookingDocument.booking_id).where(
            BookingDocument.booking_id.in_([booking.id for booking in bookings]),
            BookingDocument.kind.in_(["receipt_pdf", "receipt_docx", "receipt"]),
            or_(and_(ReceiptArchive.booking_id.is_(None), BookingDocument.kind == "receipt",
                     BookingDocument.created_at > func.now() - text("interval '5 years'")),
                and_(ReceiptArchive.expired_at.is_(None), ReceiptArchive.expires_at > func.now())))).all())
    return {"items": [booking_view(booking) | {"receipt_available": booking.id in available} for booking in bookings],
            "total": total, "page": page, "page_size": 10}


@router.get("/api/miniapp/bookings/{booking_id}/receipt")
async def customer_download_receipt(booking_id: int, preview: bool = False, user=Depends(require_customer)):
    _limit_pii(user["id"], "customer_receipt")
    try:
        body, filename = await asyncio.to_thread(customer_receipt_pdf, booking_id, user["id"])
        if preview and filename.endswith(".docx"):
            from .docx_preview import receipt_docx_preview
            return JSONResponse(await asyncio.to_thread(receipt_docx_preview, body), headers={"Cache-Control": "no-store"})
        return Response(body, media_type="application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document", headers={"Cache-Control": "no-store",
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
    from .handover import handover_state
    result["handover"] = handover_state(booking.id)
    result["assignee_id"] = booking.assignee_id
    from .db import StaffRole, TrustedSigner
    with Session() as session:
        staff = session.get(StaffRole, booking.assignee_id) if booking.assignee_id else None
        signer = session.get(TrustedSigner, booking.assignee_id) if booking.assignee_id else None
        result["assignee_name"] = (staff.display_name if staff else "") or (signer.full_name if signer else "")
    result["sla"] = request_sla(booking)
    ordered_assets = sorted(booking.assets, key=lambda row: (
        row.equipment.storage_location or "", row.equipment.article.name if row.equipment.article else row.equipment.name,
        row.equipment.inventory_number))
    result["assets"] = [{"id": asset.equipment.id,
                         "line_id":asset.booking_line_id,
                         "serial": asset.equipment.inventory_number,
                         "article_id": asset.equipment.article_id,
                         "name": catalog_title(asset.equipment.article.name, asset.equipment.article.kind, asset.equipment.article.brand, asset.equipment.article.key_spec) if asset.equipment.article else asset.equipment.name,
                         "location": asset.equipment.storage_location,
                         "inspection_profile": asset.equipment.article.inspection_profile if asset.equipment.article else "generic"}
                        for asset in ordered_assets]
    from .handover import asset_components
    with Session() as session:
        for item in result["assets"]:
            item["components"]=asset_components(session,booking.id,item["id"])
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
async def admin_bookings(page: int | None = Query(default=None, ge=0, le=100000),
                         page_size: int = Query(default=20, ge=1, le=100),
                         status: str = Query(default="all", pattern="^(all|pending|needs_changes|confirmed|preparing|ready|issued|return_inspection|returned|cancelled|expired)$"),
                         sort: str = Query(default="date", pattern="^(date|status)$"),
                         scope: str = Query(default="all", pattern="^(all|mine|unassigned|overdue|soon)$"),
                         booking_id: int | None = Query(default=None, gt=0),
                         queue: str = Query(default="all", pattern="^(all|review|handover|return)$"),
                         user=Depends(require_reviewer)):
    if page is None:
        bookings, leases = await asyncio.gather(asyncio.to_thread(list_bookings), asyncio.to_thread(operation_lease_states))
        total = len(bookings)
    else:
        (bookings, total), leases = await asyncio.gather(
            asyncio.to_thread(admin_booking_page, user["id"], page, page_size, status, sort, scope, booking_id, queue),
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
    return {"items": items, "total": total, "page": page, "page_size": page_size, "queues": await asyncio.to_thread(admin_queue_counts), "undo_seconds": deletion_undo_seconds()}


@router.get("/api/miniapp/admin/bookings/{booking_id}/history")
async def admin_booking_history(booking_id: int, page: int | None = Query(default=None, ge=0, le=100000),
                                page_size: int = Query(default=20, ge=1, le=100), user=Depends(require_reviewer)):
    try:
        if page is None:
            return {"items": await asyncio.to_thread(booking_history, booking_id)}
        items, total = await asyncio.to_thread(booking_history_page, booking_id, page, page_size)
        return {"items": items, "total": total, "page": page, "page_size": page_size}
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
async def admin_reassign_support(thread_id: int, payload: ReassignRequest, tasks: BackgroundTasks, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(reassign_thread, thread_id, user["id"], payload.assignee_id)
        tasks.add_task(notify_support_owner, payload.assignee_id, thread_id, "")
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
async def admin_catalog(page: int | None = Query(default=None, ge=0, le=100000), page_size: int = Query(default=20, ge=1, le=100),
                        q: str = Query(default="", max_length=200), condition: str = Query(default="all", pattern="^(all|available|maintenance|retired)$"),
                        category: str = Query(default="", max_length=40), user=Depends(require_admin)):
    from .inventory import inventory_details_batch
    from .catalog_images import image_data
    if page is None:
        articles = await asyncio.to_thread(list_articles)
        total = len(articles)
    else:
        articles, total = await asyncio.to_thread(list_articles_page, page, page_size, q, condition, False, category)
    with Session() as session:
        previews = image_data(session, [article.id for article in articles])
        details = inventory_details_batch([asset.id for article in articles for asset in article.equipment], session)
    dependencies = await asyncio.to_thread(list_dependencies)
    return {"categories": await asyncio.to_thread(list_categories), "articles": [{"id": article.id, "sku": article.sku, "name": article.name,
                           "is_test": article.is_test,
                           "title": catalog_title(article.name, article.kind, article.brand, article.key_spec),
                           "kind": article.kind, "brand": article.brand, "key_spec": article.key_spec,
                           "category": article.category,
                           "description": article.description,
                           "composition": article.composition or "",
                           "inspection_profile": article.inspection_profile,
                           "image_url": article.image_url,
                           "image_data": previews.get(article.id, ""),
                           "active": article.is_active,
                           "buffer_hours": article.buffer_hours,
                           "equipment": [{"id": asset.id, "serial": asset.serial_number or "",
                                          "asset_code": asset.inventory_number,
                                          "inventory_code": asset.asset_inventory_code or "",
                                          "condition": asset.condition, "location": asset.storage_location,
                                          "health": asset.health_percent, "charge": asset.charge_percent,
                                          **details[asset.id]}
                                         for asset in article.equipment]}
                          for article in articles],
            "dependencies": [{"parent_article_id": item.parent_article_id,
                               "child_article_id": item.child_article_id,
                               "parent_name": item.parent.name, "child_name": item.child.name,
                               "quantity": item.quantity, "billable": item.billable}
                              for item in dependencies], "total":total, "page":page, "page_size":page_size}


@router.get("/api/miniapp/admin/catalog/options")
async def admin_catalog_options(page: int = Query(default=0, ge=0, le=100000), page_size: int = Query(default=20, ge=1, le=100),
                                q: str = Query(default="", max_length=200), user=Depends(require_admin)):
    articles, total = await asyncio.to_thread(list_articles_page, page, page_size, q, "all", True)
    return {"items":[{"id": article.id, "name": article.name, "sku":article.sku, "description":article.description, "category":article.category} for article in articles],
            "total":total, "page":page, "page_size":page_size}


@router.put("/api/miniapp/admin/catalog/articles/{article_id}/photo")
async def admin_catalog_photo(article_id: int, photo: UploadFile = File(...), user=Depends(require_catalog_manager)):
    from .catalog_images import MAX_UPLOAD, save_image
    raw = await photo.read(MAX_UPLOAD + 1)
    await photo.close()
    try:
        await asyncio.to_thread(save_image, article_id, raw, user["id"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ok": True}


@router.delete("/api/miniapp/admin/catalog/articles/{article_id}/photo")
async def admin_delete_catalog_photo(article_id: int, user=Depends(require_catalog_manager)):
    from .catalog_images import save_image
    try:
        await asyncio.to_thread(save_image, article_id, None, user["id"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ok": True}


@router.post("/api/miniapp/admin/catalog/import-csv")
async def admin_import_catalog_csv(file: UploadFile = File(...), user=Depends(require_catalog_manager)):
    data = await file.read(MAX_CSV_BYTES + 1)
    await file.close()
    try:
        return await asyncio.to_thread(import_catalog_csv, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(409, "Артикул или серийный номер уже добавлен другим оператором") from exc


class ArticleExpected(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sku: str | None = None
    name: str | None = None
    kind: str | None = None
    brand: str | None = None
    key_spec: str | None = None
    description: str | None = None
    composition: str | None = None
    category: str | None = None
    inspection_profile: str | None = None
    buffer_hours: int | None = None
    image_url: str | None = None
    is_active: bool | None = None


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
    expected_before: ArticleExpected | None = None


@router.post("/api/miniapp/admin/catalog/articles")
async def admin_save_article(payload: ArticleRequest, user=Depends(require_catalog_manager)):
    try:
        article_id = await asyncio.to_thread(
            save_article, payload.sku, payload.name, payload.description, Decimal("0"),
            payload.category, payload.inspection_profile, payload.buffer_hours,
            payload.image_url, payload.id, payload.active, payload.composition,
            payload.kind, payload.brand, payload.key_spec, user["id"],
            expected_before=payload.expected_before.model_dump(exclude_unset=True) if payload.id and payload.expected_before else None)
        return {"id": article_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Артикул с таким SKU уже существует") from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/api/miniapp/admin/catalog/articles/{article_id}/hide")
async def admin_hide_article(article_id: int, user=Depends(require_admin)):
    from .rental import hide_article
    try:
        await asyncio.to_thread(hide_article, article_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True}


@router.delete("/api/miniapp/admin/catalog/articles/{article_id}")
async def admin_archive_article(article_id: int, user=Depends(require_admin)):
    if not staff_allows(user["id"], "admin"):
        raise HTTPException(403, "Удалять артикулы может только администратор")
    try:
        return await asyncio.to_thread(archive_article, article_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


class EquipmentExpected(BaseModel):
    model_config = ConfigDict(extra="forbid")
    article_id: int | None = None
    serial_number: str | None = None
    asset_inventory_code: str | None = None
    condition: str | None = None
    storage_location: str | None = None
    health_percent: int | None = None
    charge_percent: int | None = None


class EquipmentRequest(BaseModel):
    id: int | None = None
    article_id: int
    serial: str = Field(default="", max_length=80)
    inventory_code: str = Field(default="", max_length=80)
    condition: str = "available"
    location: str = Field(default="", max_length=120)
    health: int | None = Field(default=None, ge=0, le=100)
    charge: int | None = Field(default=None, ge=0, le=100)
    expected_before: EquipmentExpected | None = None


@router.post("/api/miniapp/admin/catalog/equipment")
async def admin_save_equipment(payload: EquipmentRequest, user=Depends(require_catalog_manager)):
    try:
        equipment_id = await asyncio.to_thread(
            save_equipment, "", "", "", 0, payload.condition, payload.id,
            None, payload.article_id, payload.location, payload.health, payload.charge,
            payload.serial, payload.inventory_code,
            expected_before=payload.expected_before.model_dump(exclude_unset=True) if payload.id and payload.expected_before else None)
        return {"id": equipment_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Экземпляр с таким инвентарным кодом уже существует") from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/api/miniapp/admin/catalog/equipment/{equipment_id}")
async def admin_delete_equipment(equipment_id: int, user=Depends(require_catalog_manager)):
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
async def admin_save_dependency(payload: DependencyRequest, user=Depends(require_catalog_manager)):
    try:
        await asyncio.to_thread(save_dependency, payload.parent_article_id,
                                payload.child_article_id, payload.quantity, payload.billable)
        return {"status": "saved"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/api/miniapp/admin/catalog/dependencies/{parent_id}/{child_id}")
async def admin_delete_dependency(parent_id: int, child_id: int, user=Depends(require_catalog_manager)):
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
                                  background_tasks: BackgroundTasks, user=Depends(require_reviewer)):
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
    required = "operator"
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
    exceptions: list[dict] = Field(default_factory=list, max_length=900)

    @field_validator("exceptions")
    @classmethod
    def validate_exceptions(cls, value):
        for row in value:
            if (set(row) - {"line_id", "reason", "note", "replacement_id","component","equipment_id","replacement_name"} or
                    type(row.get("line_id")) is not int or row["line_id"] <= 0 or
                    row.get("reason") not in {"missing", "faulty", "replacement"} or
                    not isinstance(row.get("note", ""), str) or len(row.get("note", "")) > 2000 or
                    (row.get("component") and (not isinstance(row["component"],str) or len(row["component"])>4000 or type(row.get("equipment_id")) is not int)) or
                    (row.get("component") and row.get("reason")=="replacement" and (not isinstance(row.get("replacement_name"),str) or not row["replacement_name"].strip() or len(row["replacement_name"])>200)) or
                    (not row.get("component") and row.get("reason") == "replacement" and (type(row.get("replacement_id")) is not int or row["replacement_id"] <= 0))):
                raise ValueError("Неверные данные исключения выдачи")
        return value


@router.put("/api/miniapp/admin/bookings/{booking_id}/assignments")
async def admin_assign(booking_id: int, payload: AssignmentRequest, user=Depends(require_admin)):
    if not await asyncio.to_thread(staff_allows, user["id"], "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        await asyncio.to_thread(assign_booking_assets, booking_id, user["id"], payload.assignments or None,
                                operator_name(user), payload.exceptions)
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


async def save_inspection_photo_bytes(booking_id, equipment_id, raw, content_type, user):
    if not await asyncio.to_thread(staff_allows, user["id"], "operator"):
        raise HTTPException(403, "Недостаточно прав для этого действия")
    try:
        normalized, _ = sanitize_image(raw, content_type or "")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    claimed = False
    saved = False
    try:
        await asyncio.to_thread(claim_booking_operation, booking_id, user["id"], operator_name(user), bypass_return_owner=True)
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


@router.post("/api/miniapp/admin/bookings/{booking_id}/inspection-photo")
async def admin_inspection_photo(booking_id: int, equipment_id: int = Form(...),
                                photo: UploadFile = File(...), user=Depends(require_admin)):
    raw = await photo.read(8 * 1024 * 1024 + 1)
    return await save_inspection_photo_bytes(booking_id, equipment_id, raw, photo.content_type, user)


@router.post("/api/miniapp/admin/bookings/{booking_id}/act-signed")
async def admin_act_signed(booking_id: int, user=Depends(require_pii_admin)):
    raise HTTPException(410, "Используйте подтверждение бумажной подписи расписки")


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
async def admin_generated_document(booking_id: int, kind: str, preview: bool = False, user=Depends(require_pii_admin)):
    _limit_pii(user["id"], "admin_pii")
    if kind not in {"issue", "return","contract","legacy_receipt", "receipt"}:
        raise HTTPException(404, "Документ не найден")
    try:
        body, filename = await asyncio.to_thread(operator_document, booking_id, kind, user["id"])
        if preview and kind == "receipt" and filename.endswith(".docx"):
            from .docx_preview import receipt_docx_preview
            return JSONResponse(await asyncio.to_thread(receipt_docx_preview, body), headers={"Cache-Control": "no-store"})
        return Response(body, media_type="application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Cache-Control": "no-store",
                                 "Content-Disposition": f'attachment; filename="{filename}"'})
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/documents/{kind}/download-link")
async def admin_generated_document_download_link(booking_id: int, kind: str, user=Depends(require_pii_admin)):
    if kind not in {"issue", "return","contract","legacy_receipt", "receipt"}:
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
    try:
        _, filename = await asyncio.to_thread(operator_document, booking_id, kind, user["id"])
    except ReceiptExpired as exc:
        _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
        raise HTTPException(410, str(exc)) from exc
    except (ValueError, Conflict) as exc:
        _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
        raise HTTPException(404, str(exc)) from exc
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
            media_type = "application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            body, filename = await asyncio.to_thread(operator_document, booking_id, kind, actor_id)
            media_type = "application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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


async def workflow_call(function, *args, **kwargs):
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


class SignerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=1, max_length=200)
    active: bool = True


@router.get("/api/miniapp/admin/staff")
async def admin_staff(user=Depends(require_system_admin)):
    from .db import StaffRole, TrustedSigner
    with Session() as session:
        rows = []
        for telegram_id in sorted(configured_ids("ADMIN_IDS")):
            role, signer = session.get(StaffRole, telegram_id), session.get(TrustedSigner, telegram_id)
            rows.append({"telegram_id": telegram_id, "role": role.role if role else None,
                         "full_name": signer.full_name if signer else "", "trusted": bool(signer and signer.active)})
        return {"items": rows}


@router.get("/api/miniapp/admin/assignees")
async def admin_assignees(user=Depends(require_admin)):
    if not staff_allows(user["id"], "manager"):
        raise HTTPException(403, "Передавать заявки может менеджер")
    from .db import StaffRole, TrustedSigner
    with Session() as session:
        return {"items": [{"id": row.telegram_id, "role": row.role,
                 "name": row.display_name or (signer.full_name if (signer := session.get(TrustedSigner, row.telegram_id)) else "Сотрудник")}
                for row in session.scalars(select(StaffRole).where(StaffRole.telegram_id.in_(configured_ids("ADMIN_IDS"))))]}


class StaffRoleRequest(BaseModel):
    role: str


@router.put("/api/miniapp/admin/staff/{telegram_id}/role")
async def admin_staff_role(telegram_id: int, payload: StaffRoleRequest, user=Depends(require_system_admin)):
    from .roles import set_staff_role
    await workflow_call(set_staff_role, user["id"], telegram_id, payload.role)
    return {"status": "saved"}


@router.put("/api/miniapp/admin/staff/{telegram_id}/signer")
async def admin_signer(telegram_id: int, payload: SignerRequest, user=Depends(require_system_admin)):
    from .handover import set_trusted_signer
    await workflow_call(set_trusted_signer, user["id"], telegram_id, payload.full_name, payload.active)
    return {"status": "saved"}


class AttestationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str
    acknowledged: bool = False


@router.post("/api/miniapp/bookings/{booking_id}/attest")
async def customer_attestation(booking_id: int, payload: AttestationRequest, user=Depends(require_customer)):
    from .handover import customer_attest
    await workflow_call(customer_attest, booking_id, user["id"], payload.action, payload.acknowledged)
    return booking_view(await asyncio.to_thread(get_booking, booking_id))


class PaperSignatureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    point: str
    identity_matches: bool
    paper_signed: bool


@router.post("/api/miniapp/admin/bookings/{booking_id}/migrate-receipt")
async def admin_migrate_receipt(booking_id: int, user=Depends(require_pii_admin)):
    from .handover import migrate_legacy_receipt
    await workflow_call(migrate_legacy_receipt, booking_id, user["id"])
    return admin_booking_view(await asyncio.to_thread(get_booking, booking_id))


class ExternalBlockRequest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    start: datetime
    end: datetime
    reason: str=Field(min_length=1,max_length=2000)


@router.get("/api/miniapp/admin/catalog/equipment/{equipment_id}/blocks")
async def admin_external_blocks(equipment_id:int,user=Depends(require_admin)):
    from .roadmap import external_blocks
    return {"items":await workflow_call(external_blocks,equipment_id)}


@router.post("/api/miniapp/admin/catalog/equipment/{equipment_id}/blocks")
async def admin_external_block(equipment_id:int,payload:ExternalBlockRequest,user=Depends(require_admin)):
    from .roadmap import save_external_block
    return await workflow_call(save_external_block, equipment_id, payload.start, payload.end, payload.reason, user["id"], True)


@router.get("/api/miniapp/admin/catalog/equipment/{equipment_id}/schedule")
async def admin_equipment_schedule(equipment_id:int,user=Depends(require_catalog_manager)):
    from .roadmap import external_schedule
    return {"items": await workflow_call(external_schedule, equipment_id)}


@router.delete("/api/miniapp/admin/catalog/blocks/{block_id}")
async def admin_release_external_block(block_id:int,user=Depends(require_admin)):
    from .roadmap import release_external_block
    await workflow_call(release_external_block,block_id,user["id"])
    return {"status":"released"}


class StaffSectionRequest(BaseModel):
    section:str=Field(max_length=30)


@router.put("/api/miniapp/operator/last-section")
async def operator_last_section(payload:StaffSectionRequest,user=Depends(require_admin)):
    from .roadmap import save_staff_section
    await workflow_call(save_staff_section,user["id"],payload.section)
    return {"section":payload.section}


@router.post("/api/miniapp/admin/bookings/{booking_id}/paper-signature")
async def admin_paper_signature(booking_id: int, payload: PaperSignatureRequest, user=Depends(require_signer_staff)):
    from .handover import attest_paper_signature
    await workflow_call(attest_paper_signature, booking_id, user["id"], payload.point,
                        payload.identity_matches, payload.paper_signed)
    return admin_booking_view(await asyncio.to_thread(get_booking, booking_id))


class OwnerRequest(BaseModel):
    name: str = Field(default="", max_length=200)
    contact: str = Field(default="", max_length=300)


@router.put("/api/miniapp/admin/catalog/equipment/{equipment_id}/owner")
async def admin_owner(equipment_id: int, payload: OwnerRequest, user=Depends(require_admin)):
    from .inventory import save_owner
    await workflow_call(save_owner, equipment_id, payload.name, payload.contact, user["id"])
    return {"status": "saved"}


class FeatureRequest(BaseModel):
    description: str = Field(min_length=1, max_length=2000)


@router.get("/api/miniapp/admin/catalog/equipment/{equipment_id}/features")
async def admin_features(equipment_id: int, user=Depends(require_admin)):
    from .inventory import inventory_details
    return await asyncio.to_thread(inventory_details, equipment_id)


@router.post("/api/miniapp/admin/catalog/equipment/{equipment_id}/features")
async def admin_add_feature(equipment_id: int, payload: FeatureRequest, user=Depends(require_admin)):
    from .inventory import save_feature
    return {"id": await workflow_call(save_feature, equipment_id, payload.description, user["id"])}


@router.put("/api/miniapp/admin/catalog/equipment/{equipment_id}/features/{feature_id}")
async def admin_edit_feature(equipment_id: int, feature_id: int, payload: FeatureRequest, user=Depends(require_admin)):
    from .inventory import save_feature
    return {"id": await workflow_call(save_feature, equipment_id, payload.description, user["id"], feature_id)}


@router.delete("/api/miniapp/admin/catalog/equipment/{equipment_id}/features/{feature_id}")
async def admin_remove_feature(equipment_id: int, feature_id: int, user=Depends(require_system_admin)):
    from .inventory import save_feature
    await workflow_call(save_feature, equipment_id, "", user["id"], feature_id, True)
    return {"status": "deleted"}


class FindingRequest(BaseModel):
    equipment_id: int
    kind: str
    description: str = Field(min_length=1, max_length=2000)


@router.post("/api/miniapp/admin/bookings/{booking_id}/return-finding")
async def admin_return_finding(booking_id: int, payload: FindingRequest, user=Depends(require_admin)):
    from .handover import record_return_finding
    await workflow_call(record_return_finding, booking_id, payload.equipment_id, user["id"], payload.kind, payload.description)
    return {"status": "saved"}


class RequestEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: datetime
    end: datetime
    lines: list[BookingLineRequest] = Field(min_length=1, max_length=30)


class ChangeProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change_type: str
    comment: str = Field(min_length=1, max_length=2000)
    proposed: RequestEdit | None = None


class DeclineRequest(BaseModel):
    comment:str=Field(min_length=1,max_length=2000)


@router.post("/api/miniapp/admin/bookings/{booking_id}/decline")
async def admin_decline_request(booking_id:int,payload:DeclineRequest,user=Depends(require_admin)):
    from .booking_changes import decline_request
    await workflow_call(decline_request,booking_id,user["id"],payload.comment)
    return admin_booking_view(await asyncio.to_thread(get_booking,booking_id))


@router.post("/api/miniapp/admin/bookings/{booking_id}/changes")
async def admin_propose_change(booking_id: int, payload: ChangeProposal, user=Depends(require_admin)):
    from .booking_changes import propose_change
    proposed = payload.proposed.model_dump(mode="json") if payload.proposed else None
    return {"id": await workflow_call(propose_change, booking_id, user["id"], payload.change_type, payload.comment, proposed)}


@router.get("/api/miniapp/bookings/{booking_id}/changes")
async def customer_change_view(booking_id: int, user=Depends(require_customer)):
    booking = await asyncio.to_thread(get_booking, booking_id)
    if booking is None or booking.customer_id != user["id"]:
        raise HTTPException(404, "Заявка не найдена")
    from .booking_changes import change_view
    return await workflow_call(change_view, booking_id, user["id"])


@router.get("/api/miniapp/bookings/{booking_id}/rework-reason")
async def booking_rework_reason(booking_id:int,user=Depends(require_customer)):
    from .rental import rework_reason
    return await workflow_call(rework_reason,booking_id,user["id"])


@router.get("/api/miniapp/admin/bookings/{booking_id}/changes")
async def admin_change_view(booking_id: int, user=Depends(require_admin)):
    from .booking_changes import change_view
    return await workflow_call(change_view, booking_id, user["id"], user["id"] in pii_admin_ids())


@router.put("/api/miniapp/bookings/{booking_id}")
async def customer_edit_request(booking_id: int, payload: RequestEdit, user=Depends(require_customer)):
    from .booking_changes import update_request
    await workflow_call(update_request, booking_id, user["id"], payload.start, payload.end,
                        [row.model_dump() for row in payload.lines])
    return booking_view(await asyncio.to_thread(get_booking, booking_id))


class ChangeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change_id: int
    accept: bool
    comment: str = Field(default="", max_length=2000)
    corrected: RequestEdit | None = None


@router.post("/api/miniapp/bookings/{booking_id}/changes/respond")
async def customer_respond_change(booking_id: int, payload: ChangeResponse, user=Depends(require_customer)):
    from .booking_changes import update_request
    correction = payload.corrected
    await workflow_call(update_request, booking_id, user["id"], correction.start if correction else None,
                        correction.end if correction else None,
                        [row.model_dump() for row in correction.lines] if correction else None,
                        payload.change_id, payload.accept, payload.comment)
    return booking_view(await asyncio.to_thread(get_booking, booking_id))
