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
from urllib.parse import parse_qsl
from uuid import UUID

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form, Header,
                     HTTPException, Query, UploadFile)
from fastapi.responses import HTMLResponse, Response
from fastapi.routing import APIRoute
from aiogram.enums import ParseMode
from icalendar import Calendar, Event
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select

from .documents import archived_document, operator_document
from . import __version__
from .db import BookingDocument, Inspection, Session
from .pii import (DOCUMENT_KINDS, IdentityFieldError, _master_key, block_identity, consent_text, delete_identity,
                  identity_document, identity_status, masked_identity, pii_admin_ids,
                  reusable_identity_fields,
                  reusable_identity_document,
                  reveal_identity, review_identity, sanitize_image, submit_identity,
                  validate_identity_payload)
from .rental import (Conflict, assign_booking_assets, availability, create_booking,
                     close_repair, delete_booking, delete_dependency, get_booking,
                     list_articles, list_bookings, list_customer_bookings,
                     list_dependencies, list_equipment, list_repairs, mark_act_signed,
                     record_inspection, save_article, save_dependency, save_equipment,
                     transition, update_booking_contact)
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
    return {int(value.strip()) for value in os.getenv(name, "").split(",") if value.strip().isdigit()}


def require_admin(user=Depends(require_customer)):
    if user["id"] not in _ids("ADMIN_IDS") and user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Доступ только для сотрудников")
    return user


def require_pii_admin(user=Depends(require_customer)):
    if user["id"] not in pii_admin_ids():
        raise HTTPException(403, "Нет доступа к персональным данным")
    return user


def booking_view(booking):
    return {
        "id": booking.id,
        "status": booking.status,
        "starts_at": booking.starts_at.isoformat(),
        "ends_at": booking.ends_at.isoformat(),
        "hold_expires_at": booking.hold_expires_at.isoformat() if booking.hold_expires_at else None,
        "customer_name": booking.customer_name,
        "customer_contact": booking.customer_contact,
        "identity_status": booking.identity_status,
        "items": [{"id": line.article_id, "name": line.article.name, "quantity": line.quantity,
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
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return
    from .bot import make_bot, notify_managers
    try:
        async with make_bot(token) as bot:
            await notify_managers(bot, booking_id)
            await bot.send_message(customer_id, f"<b>Заявка №{booking_id} создана</b>\nОборудование удерживается 30 минут. Ожидайте подтверждения менеджера.", parse_mode=ParseMode.HTML)
    except Exception:
        pass


async def notify_cancelled_booking(booking_id: int):
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return
    from .bot import make_bot
    try:
        from .bot import customer_label
        booking = await asyncio.to_thread(get_booking, booking_id)
        label = customer_label(booking) if booking else "клиент"
        async with make_bot(token) as bot:
            for admin_id in os.getenv("ADMIN_IDS", "").split(","):
                if admin_id.strip().isdigit():
                    try:
                        await bot.send_message(int(admin_id), f"<b>{html.escape(label)}</b> отменил заявку №{booking_id}.", parse_mode=ParseMode.HTML)
                    except Exception:
                        pass
    except Exception:
        pass


async def notify_booking_status(booking_id: int, customer_id: int, status: str):
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return
    labels = {"confirmed": "подтверждён — заполните документы в Mini App",
              "preparing": "передан в подготовку", "ready": "готов к выдаче",
              "issued": "выдан", "return_inspection": "принят на проверку",
              "returned": "возврат завершён", "cancelled": "отменён"}
    from .bot import make_bot
    try:
        async with make_bot(token) as bot:
            await bot.send_message(customer_id, f"<b>Обновление по заявке №{booking_id}</b>\nСтатус: {html.escape(labels.get(status, status))}.", parse_mode=ParseMode.HTML)
    except Exception:
        pass


async def notify_identity_submitted(booking_id: int):
    """Tell operators that identity data was submitted or corrected; never include PII."""
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        return
    recipient_ids = _ids("ADMIN_IDS") | pii_admin_ids()
    if not recipient_ids:
        return
    from .bot import make_bot
    try:
        async with make_bot(token) as bot:
            for recipient_id in recipient_ids:
                try:
                    await bot.send_message(recipient_id,
                        f"<b>Анкета обновлена · заявка №{booking_id}</b>\nПроверьте документы клиента в Mini App.", parse_mode=ParseMode.HTML)
                except Exception:
                    pass
    except Exception:
        pass


@router.get("/miniapp")
def miniapp_page():
    return HTMLResponse(miniapp_html(), headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


def miniapp_html():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8").replace("__APP_VERSION__", __version__)


@router.get("/calendar/{token}.ics")
def calendar_feed(token: str):
    expected = os.getenv("ICAL_TOKEN", "")
    if not expected or not hmac.compare_digest(token, expected):
        raise HTTPException(404)
    calendar = Calendar()
    calendar.add("prodid", "-//PolyRental//Calendar//RU")
    calendar.add("version", "2.0")
    for booking in list_bookings(limit=None):
        if booking.status not in {"confirmed", "preparing", "ready", "issued", "return_inspection"}:
            continue
        event = Event()
        event.add("uid", f"booking-{booking.id}@polyrental")
        equipment = ", ".join(f"{line.article.name} × {line.quantity}" for line in booking.lines)
        event.add("summary", f"Аренда №{booking.id}: {equipment or 'оборудование'}")
        event.add("description", f"PolyRental · статус: {booking.status}")
        event.add("dtstart", booking.starts_at)
        event.add("dtend", booking.ends_at)
        calendar.add_component(event)
    return Response(calendar.to_ical(), media_type="text/calendar")


@router.get("/api/miniapp/availability")
async def equipment_availability(start: datetime = Query(), end: datetime = Query()):
    try:
        items = await asyncio.to_thread(availability, start, end)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    available = [item for item in items if item["available"]]
    return {
        "items": available,
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
    booking = await asyncio.to_thread(get_booking, booking_id)
    if created:
        background_tasks.add_task(notify_new_booking, booking_id, user["id"])
    return booking_view(booking)


@router.get("/api/miniapp/me")
async def current_role(user=Depends(require_customer)):
    return {"id": user["id"], "admin": user["id"] in _ids("ADMIN_IDS") or user["id"] in pii_admin_ids(),
            "pii_admin": user["id"] in pii_admin_ids()}


@router.get("/api/miniapp/bookings")
async def customer_bookings(user=Depends(require_customer)):
    bookings = await asyncio.to_thread(list_customer_bookings, user["id"])
    return {"items": [booking_view(booking) for booking in bookings]}


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
    ordered_assets = sorted(booking.assets, key=lambda row: (
        row.equipment.storage_location or "", row.equipment.article.name if row.equipment.article else row.equipment.name,
        row.equipment.inventory_number))
    result["assets"] = [{"id": asset.equipment.id,
                         "serial": asset.equipment.inventory_number,
                         "article_id": asset.equipment.article_id,
                         "name": asset.equipment.article.name if asset.equipment.article else asset.equipment.name,
                         "location": asset.equipment.storage_location,
                         "inspection_profile": asset.equipment.article.inspection_profile if asset.equipment.article else "generic"}
                        for asset in ordered_assets]
    result["pick_list"] = result["assets"]
    result["inspections"] = [{"equipment_id": inspection.equipment_id, "stage": inspection.stage,
                              "result": inspection.result, "notes": inspection.notes,
                              "defect": inspection.defect, "estimated_cost": str(inspection.estimated_cost),
                              "charge_customer": inspection.charge_customer,
                              "created_at": inspection.created_at.isoformat() if inspection.created_at else None}
                             for inspection in booking.inspections]
    result["act_signed_at"] = booking.act_signed_at.isoformat() if booking.act_signed_at else None
    with Session() as session:
        result["archived_documents"] = session.scalars(select(BookingDocument.kind).where(
            BookingDocument.booking_id == booking.id)).all()
    result["lines"] = [{"id": line.id, "article_id": line.article_id,
                         "name": line.article.name, "quantity": line.quantity}
                        for line in booking.lines]
    return result


@router.get("/api/miniapp/admin/bookings")
async def admin_bookings(user=Depends(require_admin)):
    return {"items": [admin_booking_view(booking) for booking in await asyncio.to_thread(list_bookings)]}


@router.delete("/api/miniapp/admin/bookings/{booking_id}")
async def admin_delete_booking(booking_id: int, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(delete_booking, booking_id, user["id"])
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    for token, claim in list(_DOCUMENT_DOWNLOAD_TOKENS.items()):
        if claim[0] == booking_id:
            _DOCUMENT_DOWNLOAD_TOKENS.pop(token, None)
    return {"status": "deleted", "booking_id": booking_id}


@router.get("/api/miniapp/admin/catalog")
async def admin_catalog(user=Depends(require_admin)):
    articles = await asyncio.to_thread(list_articles)
    dependencies = await asyncio.to_thread(list_dependencies)
    return {"articles": [{"id": article.id, "sku": article.sku, "name": article.name,
                           "category": article.category,
                           "description": article.description,
                           "composition": article.composition or "",
                           "inspection_profile": article.inspection_profile,
                           "image_url": article.image_url,
                           "active": article.is_active,
                           "buffer_hours": article.buffer_hours,
                           "equipment": [{"id": asset.id, "serial": asset.inventory_number,
                                          "condition": asset.condition, "location": asset.storage_location,
                                          "health": asset.health_percent, "charge": asset.charge_percent}
                                         for asset in article.equipment]}
                          for article in articles],
            "dependencies": [{"parent_article_id": item.parent_article_id,
                               "child_article_id": item.child_article_id,
                               "quantity": item.quantity, "billable": item.billable}
                              for item in dependencies]}


class ArticleRequest(BaseModel):
    id: int | None = None
    sku: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
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
            payload.image_url, payload.id, payload.active, payload.composition)
        return {"id": article_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Артикул с таким SKU уже существует") from exc
    except (ValueError, Conflict) as exc:
        raise HTTPException(422, str(exc)) from exc


class EquipmentRequest(BaseModel):
    id: int | None = None
    article_id: int
    serial: str = Field(min_length=1, max_length=80)
    condition: str = "available"
    location: str = Field(default="", max_length=120)
    health: int | None = Field(default=None, ge=0, le=100)
    charge: int | None = Field(default=None, ge=0, le=100)


@router.post("/api/miniapp/admin/catalog/equipment")
async def admin_save_equipment(payload: EquipmentRequest, user=Depends(require_admin)):
    try:
        equipment_id = await asyncio.to_thread(
            save_equipment, payload.serial, "", "", 0, payload.condition, payload.id,
            None, payload.article_id, payload.location, payload.health, payload.charge)
        return {"id": equipment_id}
    except IntegrityError as exc:
        raise HTTPException(422, "Экземпляр с таким серийным номером уже существует") from exc
    except (ValueError, Conflict) as exc:
        raise HTTPException(422, str(exc)) from exc


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


@router.post("/api/miniapp/admin/bookings/{booking_id}/transition")
async def admin_transition(booking_id: int, payload: TransitionRequest,
                           background_tasks: BackgroundTasks, user=Depends(require_admin)):
    try:
        status = await asyncio.to_thread(transition, booking_id, payload.action, user["id"])
        booking = await asyncio.to_thread(get_booking, booking_id)
        background_tasks.add_task(notify_booking_status, booking_id, booking.customer_id, status)
        return admin_booking_view(booking) | {"status": status}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc


class AssignmentRequest(BaseModel):
    assignments: dict[str, list[int]] = Field(default_factory=dict)


@router.put("/api/miniapp/admin/bookings/{booking_id}/assignments")
async def admin_assign(booking_id: int, payload: AssignmentRequest, user=Depends(require_admin)):
    try:
        await asyncio.to_thread(assign_booking_assets, booking_id, user["id"], payload.assignments or None)
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
    try:
        await asyncio.to_thread(record_inspection, booking_id, payload.equipment_id, payload.stage,
                                payload.result, payload.checklist, payload.notes, user["id"],
                                payload.defect, payload.estimated_cost, payload.charge_customer)
        return {"status": "saved"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/api/miniapp/admin/bookings/{booking_id}/inspection-photo")
async def admin_inspection_photo(booking_id: int, equipment_id: int = Form(...),
                                photo: UploadFile = File(...), user=Depends(require_admin)):
    raw = await photo.read(8 * 1024 * 1024 + 1)
    try:
        normalized, _ = sanitize_image(raw, photo.content_type or "")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
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
    return {"status": "saved"}


@router.post("/api/miniapp/admin/bookings/{booking_id}/act-signed")
async def admin_act_signed(booking_id: int, user=Depends(require_pii_admin)):
    try:
        await asyncio.to_thread(mark_act_signed, booking_id, user["id"])
        await asyncio.to_thread(archived_document, booking_id, "issue", user["id"])
        await asyncio.to_thread(archived_document, booking_id, "receipt", user["id"])
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
    try:
        await asyncio.to_thread(review_identity, booking_id, user["id"], payload.approved, payload.comment, payload.fields)
        booking = await asyncio.to_thread(get_booking, booking_id)
        if not payload.approved:
            background_tasks.add_task(notify_booking_status, booking_id, booking.customer_id,
                                      "документы требуют исправления — откройте Mini App")
        return {"status": "verified" if payload.approved else "needs_changes"}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


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
    token = secrets.token_urlsafe(32)
    _DOCUMENT_DOWNLOAD_TOKENS[token] = (booking_id, kind, user["id"], current + 120)
    filename = f"{'act' if kind == 'issue' else 'receipt'}-{booking_id}.docx"
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
        body, filename = await asyncio.to_thread(operator_document, booking_id, kind, actor_id)
        return Response(body, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Cache-Control": "no-store, max-age=0",
                                 "Content-Disposition": f'attachment; filename="{filename}"',
                                 "Access-Control-Allow-Origin": "https://web.telegram.org",
                                 "Access-Control-Expose-Headers": "Content-Disposition",
                                 "Vary": "Origin"})
    except (ValueError, Conflict) as exc:
        raise HTTPException(409, str(exc)) from exc


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
