import asyncio
import html
import logging
import os
from datetime import datetime, timedelta
import re
import secrets
from uuid import uuid4
from zoneinfo import ZoneInfo

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.enums import ParseMode
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, MenuButtonWebApp, Message, ReplyKeyboardMarkup, WebAppInfo
from sqlalchemy.exc import IntegrityError

from .db import init_db
from .booking_messages import booking_status_text
from .notification_outbox import notify, notify_actionable
from .miniapp import BookingRequest
from .roles import configured_ids, is_staff, audit_admin_access, validate_role_config, staff_allows
from .service import Conflict, availability, booking_total, create_booking, get_booking, list_bookings, list_customer_bookings, list_equipment, save_equipment, transition
from .rental import resolve_booking_number, ClientBlocked
from .support import submit_question, reply as support_reply, deliver_reply, SupportConflict
from .catalog_titles import catalog_title

router = Router()
fallback_router = Router(name='booking_fallback')
MOSCOW = ZoneInfo("Europe/Moscow")


class UserNameMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        from .user_names import remember_user_name
        if event.from_user:
            await asyncio.to_thread(remember_user_name, event.from_user)
        return await handler(event, data)


def make_bot(token):
    proxy = os.getenv("HTTPS_PROXY") or os.getenv("https_proxy")
    options = {"proxy": proxy} if proxy else {}
    if os.getenv("TELEGRAM_TEST_ENVIRONMENT") == "1":
        options["api"] = TelegramAPIServer(
            base="https://api.telegram.org/bot{token}/test/{method}",
            file="https://api.telegram.org/file/bot{token}/test/{path}",
        )
    return Bot(token, session=AiohttpSession(**options) if options else None)


def customer_label(booking):
    from .user_names import clean_name
    name = clean_name(booking.customer_name)
    contact = (booking.customer_contact or "").strip()
    if contact.startswith("@") and contact.lower() not in name.lower():
        return f"{name} ({contact})" if name else contact
    return name or "Пользователь"


class Rent(StatesGroup):
    start = State()
    end = State()
    equipment = State()
    name = State()
    contact = State()
    review = State()


class Support(StatesGroup):
    message = State()


def parse_time(value):
    value = value.strip().lower().replace('ё', 'е')
    current = datetime.now(MOSCOW)
    match = re.fullmatch(r'(сегодня|завтра)\s+(\d{1,2})(?::(\d{2}))?', value)
    if match:
        day = current.date() + timedelta(days=match.group(1) == 'завтра')
        return datetime(day.year, day.month, day.day, int(match.group(2)), int(match.group(3) or 0), tzinfo=MOSCOW)
    match = re.fullmatch(r'(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\s+(\d{1,2})(?::(\d{2}))?', value)
    if not match:
        raise ValueError('Напишите дату и время, например: 15.11 14:30 или завтра 10:00.')
    day, month, year, hour, minute = match.groups()
    year = int(year) if year else current.year
    result = datetime(year, int(month), int(day), int(hour), int(minute or 0), tzinfo=MOSCOW)
    if not match.group(3) and result.date() < current.date():
        result = result.replace(year=year + 1)
    return result


def booking_created_text(booking):
    return (f"<b>Заявка {getattr(booking, 'human_number', None) or f'№{booking.id}'} создана</b>\n"
            "<i>Ожидает решения оператора.</i> Заявка остаётся в очереди до подтверждения или отмены.")


def is_admin(user_id):
    return staff_allows(user_id, "operator")


def format_items(items):
    lines = []
    for item in items:
        status = f'свободно: {item["available_quantity"]}' if item["available"] else "недоступно"
        lines.append(f'{item["id"]}: {item.get("title") or item["name"]} ({item["sku"]}) — {status}')
    return "\n".join(lines) or "Оборудование пока не добавлено"


def miniapp_url():
    url = os.getenv("PUBLIC_URL", "").rstrip("/")
    allowed = url.startswith("https://") or (
        os.getenv("TELEGRAM_TEST_ENVIRONMENT") == "1" and url.startswith("http://")
    )
    return f"{url}/miniapp" if allowed else None


def main_keyboard():
    # Reply-keyboard WebApps may lack signed initData. Launch through the
    # message handler's inline WebApp so every role is authenticated by API.
    book_button = KeyboardButton(text="Забронировать")
    return ReplyKeyboardMarkup(keyboard=[[book_button], [KeyboardButton(text="Бронирование в чате")], [KeyboardButton(text="Мои заявки"), KeyboardButton(text="Связаться с менеджером")]], resize_keyboard=True)


def flow_keyboard(contact=False):
    rows = [[KeyboardButton(text="Назад"), KeyboardButton(text="Отмена")]]
    if contact:
        rows.insert(0, [KeyboardButton(text="Поделиться телефоном", request_contact=True)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def equipment_keyboard(items, selected):
    quantities = selected if isinstance(selected, dict) else {item_id: 1 for item_id in selected}
    buttons = []
    for item in items:
        item_id = item["id"]
        count = quantities.get(str(item_id), quantities.get(item_id, 0))
        buttons.append([InlineKeyboardButton(text=f'{item.get("title") or item["name"]} · {count} / {item["available_quantity"]}', callback_data=f'rent:info:{item_id}'),
                        InlineKeyboardButton(text="−", callback_data=f'rent:minus:{item_id}'),
                        InlineKeyboardButton(text="+", callback_data=f'rent:plus:{item_id}')])
    buttons.append([InlineKeyboardButton(text="Продолжить →", callback_data="rent:next")])
    buttons.append([InlineKeyboardButton(text="Показать мой выбор", callback_data="rent:selected")])
    buttons.append([InlineKeyboardButton(text="Изменить сроки", callback_data="rent:dates")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


async def notify_managers(_bot, booking_id):
    # Unassigned requests appear in the shared queue without a push.
    return None


async def show_equipment(message, state):
    data = await state.get_data()
    try:
        items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
    except ValueError:
        await state.set_state(Rent.start)
        return await message.answer("Время начала уже прошло. Выберите новый срок выдачи.", reply_markup=flow_keyboard())
    available = [item for item in items if item["available"]]
    if not available:
        await message.answer("На этот срок свободного оборудования нет. Нажмите «Назад» и измените даты.", reply_markup=flow_keyboard())
        return
    selected = {str(item["id"]): min(int(data.get("quantities", {}).get(str(item["id"]), 1 if item["id"] in data.get("ids", []) else 0)), item["available_quantity"], 30) for item in available}
    selected = {key: value for key, value in selected.items() if value > 0}
    await state.update_data(ids=sorted(map(int, selected)), quantities=selected, equipment_query='')
    await message.answer("Выберите оборудование кнопками + и −. Для поиска отправьте название или модель.", reply_markup=flow_keyboard())
    await message.answer("Доступно на выбранный срок:", reply_markup=equipment_keyboard(available, selected))


async def show_review(message, state):
    data = await state.get_data()
    start_at, end_at = datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"])
    try:
        items = await asyncio.to_thread(availability, start_at, end_at)
    except ValueError:
        await state.set_state(Rent.start)
        return await message.answer("Время начала уже прошло. Выберите новый срок выдачи.", reply_markup=flow_keyboard())
    chosen = [item for item in items if item["id"] in data["ids"]]
    if len(chosen) != len(data["ids"]) or any(not item["available"] or data.get("quantities", {}).get(str(item["id"]), 1) > item["available_quantity"] for item in chosen):
        await state.set_state(Rent.equipment)
        await message.answer("Выбранное оборудование уже занято. Выберите другое или измените сроки.", reply_markup=flow_keyboard())
        return await show_equipment(message, state)
    await state.update_data(expected_total=None, editing=None)
    quantities = data.get("quantities", {})
    items_text = "\n".join(f"• {html.escape(item.get('title') or item['name'])} × {quantities.get(str(item['id']), 1)}" for item in chosen)
    text = (f"<b>Проверьте заявку</b>\n\n<u>Период</u>: {start_at.astimezone(MOSCOW):%d.%m.%Y %H:%M} — {end_at.astimezone(MOSCOW):%d.%m.%Y %H:%M} МСК\n"
            f"<u>Оборудование</u>\n{items_text}\n\n<b>Имя:</b> {html.escape(data['name'])}\n<b>Контакт:</b> <tg-spoiler>{html.escape(data['contact'])}</tg-spoiler>\n\n"
            "<i>После отправки заявка будет ждать решения оператора без ограничения по времени.</i>")
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Подтвердить бронирование", callback_data="rent:confirm")],
        [InlineKeyboardButton(text="Изменить сроки", callback_data="rent:edit:start"), InlineKeyboardButton(text="Изменить оборудование", callback_data="rent:edit:equipment")],
        [InlineKeyboardButton(text="Изменить имя", callback_data="rent:edit:name"), InlineKeyboardButton(text="Изменить контакт", callback_data="rent:edit:contact")],
        [InlineKeyboardButton(text="Отмена", callback_data="rent:cancel")],
    ])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=keyboard)


@router.message(CommandStart())
async def start(message: Message, state: FSMContext):
    await state.clear()
    text = "<b>ПолиРентал</b>\nВыберите сроки и оборудование, чтобы оформить аренду."
    if not miniapp_url():
        text += " Приложение бронирования временно недоступно."
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=main_keyboard())


@router.message(Command("book"))
@router.message(F.text == "Забронировать")
async def book(message: Message, state: FSMContext):
    if miniapp_url():
        staff = is_staff(message.from_user.id)
        if staff:
            audit_admin_access(message.from_user.id, "bot_book")
        await message.answer("Выберите даты и оборудование в приложении.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Открыть каталог", web_app=WebAppInfo(url=f"{miniapp_url()}?startapp=booking"))],
        ]))
        return
    await message.answer("Приложение бронирования временно недоступно. Обратитесь к оператору.")


@router.message(F.web_app_data)
async def booking_from_miniapp(message: Message, bot: Bot):
    if message.chat.type != "private" or not message.from_user:
        return
    raw = message.web_app_data.data
    if len(raw.encode()) > 4096:
        return await message.answer("Заявка слишком большая. Откройте приложение и попробуйте ещё раз.")
    try:
        payload = BookingRequest.model_validate_json(raw)
        booking_id, created = await asyncio.to_thread(
            create_booking, message.from_user.id, payload.name.strip(), payload.contact.strip(), payload.start,
            payload.end, [line.model_dump() for line in payload.lines], str(payload.request_id), payload.expected_total, return_created=True,
        )
    except (ValueError, Conflict, ClientBlocked) as exc:
        return await message.answer(f"Не удалось создать заявку: {exc}. Откройте приложение и проверьте сроки, оборудование и контакты.", reply_markup=main_keyboard())
    booking = await asyncio.to_thread(get_booking, booking_id)
    await message.answer(booking_created_text(booking), parse_mode=ParseMode.HTML, reply_markup=main_keyboard())
    if created:
        await notify_managers(bot, booking_id)


async def begin_chat_booking(message, state):
    await state.clear()
    await state.update_data(request_id=str(uuid4()))
    await state.set_state(Rent.start)
    await message.answer("Когда получите оборудование? Напишите дату и время по Москве, например: 15.11 14:30 или завтра 10:00.", reply_markup=flow_keyboard())


@router.message(Command("book_chat"))
@router.message(F.text == "Бронирование в чате")
async def book_chat(message: Message, state: FSMContext):
    await begin_chat_booking(message, state)


@router.callback_query(F.data == "rent:chat")
async def book_chat_button(query: CallbackQuery, state: FSMContext):
    await query.answer()
    await state.clear()
    if miniapp_url():
        await query.message.answer("Выберите даты и оборудование в приложении.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Открыть каталог", web_app=WebAppInfo(url=f"{miniapp_url()}?startapp=booking"))]]))
    else:
        await query.message.answer("Приложение бронирования временно недоступно. Обратитесь к оператору.")


@router.message(F.text == "Отмена")
@router.message(Command("cancel_booking"))
async def cancel_flow(message: Message, state: FSMContext):
    if (await state.get_state()) not in {Rent.start.state, Rent.end.state, Rent.equipment.state, Rent.name.state, Rent.contact.state, Rent.review.state}:
        return await message.answer('Нет незавершённого бронирования.', reply_markup=main_keyboard())
    await ask_cancel(message, state)


async def ask_cancel(message, state):
    nonce = secrets.token_hex(4)
    await state.update_data(cancel_nonce=nonce)
    await message.answer('Точно хотите отменить оформление?', reply_markup=InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text='Да, отменить', callback_data=f'rent:cancel:yes:{nonce}'), InlineKeyboardButton(text='Нет, продолжить', callback_data=f'rent:cancel:no:{nonce}')]]))


@router.message(F.text == "Назад")
async def back_flow(message: Message, state: FSMContext):
    current = await state.get_state()
    if current == Support.message.state:
        await state.clear()
        return await message.answer("Вы вернулись в главное меню.", reply_markup=main_keyboard())
    previous = {Rent.end.state: Rent.start, Rent.equipment.state: Rent.end, Rent.name.state: Rent.equipment, Rent.contact.state: Rent.name, Rent.review.state: Rent.contact}
    target = previous.get(current)
    if not target:
        return await message.answer("Вы уже в начале. Выберите дату или нажмите «Отмена».", reply_markup=flow_keyboard())
    await state.set_state(target)
    if target == Rent.equipment:
        return await show_equipment(message, state)
    prompts = {Rent.start: "Введите дату и время выдачи по Москве: ДД.ММ.ГГГГ ЧЧ:ММ", Rent.end: "Введите дату и время возврата по Москве: ДД.ММ.ГГГГ ЧЧ:ММ", Rent.name: "Введите имя для заявки и документов:", Rent.contact: "Введите телефон или Telegram для связи:"}
    await message.answer(prompts[target], reply_markup=flow_keyboard(contact=target == Rent.contact))


@router.message(Rent.start)
async def rental_start(message: Message, state: FSMContext):
    try:
        start_at = parse_time(message.text or "")
    except ValueError:
        return await message.answer("Напишите дату и время, например: 15.11 14:30 или завтра 10:00.")
    await state.update_data(start=start_at.isoformat())
    await state.set_state(Rent.end)
    await message.answer("Когда вернёте оборудование? Например: 16.11 17:00 или завтра 17:00. Время московское.", reply_markup=flow_keyboard())


@router.message(Rent.end)
async def rental_end(message: Message, state: FSMContext):
    try:
        end_at = parse_time(message.text or "")
        start_at = datetime.fromisoformat((await state.get_data())["start"])
        items = await asyncio.to_thread(availability, start_at, end_at)
    except ValueError as exc:
        return await message.answer(str(exc))
    await state.update_data(end=end_at.isoformat())
    data = await state.get_data()
    if data.get('editing') == 'start' and data.get('name') and data.get('contact'):
        await state.set_state(Rent.review)
        return await show_review(message, state)
    await state.set_state(Rent.equipment)
    await show_equipment(message, state)


@router.message(Rent.equipment)
async def rental_equipment(message: Message, state: FSMContext):
    try:
        ids = sorted(set(int(part.strip()) for part in (message.text or "").split(",")))
        data = await state.get_data()
        items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
        if not ids or not set(ids).issubset({item["id"] for item in items if item["available"]}):
            raise ValueError()
    except ValueError:
        query = (message.text or "").strip().casefold()
        if not query:
            return await message.answer("Введите название или модель для поиска.")
        data = await state.get_data()
        try:
            items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
        except ValueError:
            return await message.answer("Проверьте сроки заявки.")
        found = [item for item in items if item["available"] and query in " ".join(str(item.get(k) or "") for k in ("name", "title", "sku", "brand", "description")).casefold()]
        await state.update_data(equipment_query=query)
        if not found:
            return await message.answer("Ничего не найдено. Введите другое название или нажмите «Назад».")
        return await message.answer("Результаты поиска:", reply_markup=equipment_keyboard(found, data.get("quantities", {})))
    await state.update_data(ids=ids, quantities={str(item_id): 1 for item_id in ids})
    if data.get("editing") in {"start", "equipment"} and data.get("name") and data.get("contact"):
        await state.set_state(Rent.review)
        return await show_review(message, state)
    await state.set_state(Rent.name)
    await message.answer("Как к вам обращаться? Введите имя для документов:", reply_markup=flow_keyboard())


@router.callback_query(F.data.startswith("rent:info:"))
async def equipment_info(query: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    if await state.get_state() != Rent.equipment.state:
        return await query.answer('Откройте выбор оборудования заново.', show_alert=True)
    items = await asyncio.to_thread(availability, datetime.fromisoformat(data['start']), datetime.fromisoformat(data['end']))
    item = next((item for item in items if str(item['id']) == query.data.rsplit(':', 1)[-1]), None)
    if not item: return await query.answer('Позиция больше недоступна.', show_alert=True)
    await query.answer()
    await query.message.answer(f"{item.get('title') or item['name']}\nВыбрано: {data.get('quantities', {}).get(str(item['id']), 0)} шт.\nДоступно: {item['available_quantity']} шт.")


@router.callback_query(F.data == 'rent:selected')
async def show_selection(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.equipment.state:
        return await query.answer('Откройте выбор оборудования заново.', show_alert=True)
    data = await state.get_data()
    items = await asyncio.to_thread(availability, datetime.fromisoformat(data['start']), datetime.fromisoformat(data['end']))
    lines = [f"• {item.get('title') or item['name']} × {data['quantities'][str(item['id'])]}" for item in items if str(item['id']) in data.get('quantities', {})]
    await query.answer()
    await query.message.answer('Ваш выбор:\n' + ('\n'.join(lines) if lines else 'Пока ничего не выбрано.'))


@router.callback_query(F.data == 'rent:dates')
async def change_dates(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.equipment.state:
        return await query.answer('Откройте оформление заново.', show_alert=True)
    await state.update_data(editing='start')
    await state.set_state(Rent.start)
    await query.answer()
    await query.message.answer('Новая дата и время получения, например: 15.11 14:30 или завтра 10:00. Ваш выбор сохранён.', reply_markup=flow_keyboard())


@router.callback_query(F.data.startswith("rent:plus:") | F.data.startswith("rent:minus:"))
async def change_equipment_quantity(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.equipment.state:
        return await query.answer("Начните бронирование заново", show_alert=True)
    data = await state.get_data()
    _, action, raw_id = query.data.split(":")
    item_id = int(raw_id)
    try:
        items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
    except ValueError:
        return await query.answer("Проверьте сроки заявки", show_alert=True)
    item = next((row for row in items if row["id"] == item_id), None)
    quantities = dict(data.get("quantities", {}))
    count = int(quantities.get(raw_id, 0))
    limit = min(30, item["available_quantity"]) if item else 0
    if action == "plus" and count >= limit:
        return await query.answer("Больше свободных единиц нет", show_alert=True)
    count = count + 1 if action == "plus" else max(0, count - 1)
    if count: quantities[raw_id] = count
    else: quantities.pop(raw_id, None)
    await state.update_data(ids=sorted(map(int, quantities)), quantities=quantities)
    await query.answer("Выбор обновлён")
    search = data.get("equipment_query", "")
    visible = [row for row in items if row["available"] and search in " ".join(str(row.get(k) or "") for k in ("name", "title", "sku", "brand", "description")).casefold()]
    await query.message.edit_reply_markup(reply_markup=equipment_keyboard(visible, quantities))


@router.callback_query(F.data.startswith("rent:toggle:"))
async def toggle_equipment(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.equipment.state:
        return await query.answer("Начните бронирование заново", show_alert=True)
    data = await state.get_data()
    item_id = int(query.data.rsplit(":", 1)[1])
    try:
        items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
    except ValueError:
        await state.set_state(Rent.start)
        await query.answer("Время начала уже прошло", show_alert=True)
        return await query.message.answer("Выберите новую дату выдачи.", reply_markup=flow_keyboard())
    if item_id not in {item["id"] for item in items if item["available"]}:
        return await query.answer("Этот артикул уже недоступен", show_alert=True)
    selected = set(data.get("ids", []))
    if item_id in selected: selected.remove(item_id)
    else: selected.add(item_id)
    await state.update_data(ids=sorted(selected))
    await query.answer("Выбор обновлён")
    await query.message.edit_reply_markup(reply_markup=equipment_keyboard([item for item in items if item["available"]], selected))


@router.callback_query(F.data == "rent:next")
async def next_equipment(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.equipment.state:
        return await query.answer("Начните бронирование заново", show_alert=True)
    data = await state.get_data()
    if not data.get("ids"):
        return await query.answer("Выберите хотя бы одну позицию", show_alert=True)
    await query.answer()
    if data.get("editing") in {"start", "equipment"} and data.get("name") and data.get("contact"):
        await state.set_state(Rent.review)
        return await show_review(query.message, state)
    await state.set_state(Rent.name)
    await query.message.answer("Как к вам обращаться? Введите имя для документов:", reply_markup=flow_keyboard())


@router.message(Rent.name)
async def rental_name(message: Message, state: FSMContext):
    if not message.text or not message.text.strip():
        return await message.answer("Введите имя")
    await state.update_data(name=message.text.strip())
    data = await state.get_data()
    if data.get("editing") == "name" and data.get("contact"):
        await state.set_state(Rent.review)
        return await show_review(message, state)
    await state.set_state(Rent.contact)
    await message.answer("Введите телефон или Telegram для связи с менеджером:", reply_markup=flow_keyboard(contact=True))


@router.message(Rent.contact)
async def rental_contact(message: Message, state: FSMContext):
    contact = (message.contact.phone_number if message.contact else message.text or "").strip()
    if not contact:
        return await message.answer("Укажите телефон или Telegram для связи.")
    await state.update_data(contact=contact)
    await state.set_state(Rent.review)
    await show_review(message, state)


@router.message(Rent.review)
async def review_text(message: Message):
    await message.answer("Проверьте заявку и используйте кнопки «Подтвердить бронирование» или «Изменить».")


@router.callback_query(F.data.startswith("rent:edit:"))
async def edit_booking_step(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.review.state:
        return await query.answer("Начните бронирование заново", show_alert=True)
    target = query.data.rsplit(":", 1)[1]
    states = {"start": Rent.start, "equipment": Rent.equipment, "name": Rent.name, "contact": Rent.contact}
    if target not in states:
        return await query.answer()
    await state.update_data(editing=target)
    await state.set_state(states[target]); await query.answer()
    if target == "equipment": return await show_equipment(query.message, state)
    prompts = {"start": "Новая дата и время получения, например: 15.11 14:30 или завтра 10:00. Ваш выбор сохранён.", "name": "Введите новое имя:", "contact": "Введите новый телефон или Telegram:"}
    await query.message.answer(prompts[target], reply_markup=flow_keyboard(contact=target == "contact"))


@router.callback_query(F.data == "rent:cancel")
async def cancel_review(query: CallbackQuery, state: FSMContext):
    if await state.get_state() != Rent.review.state:
        return await query.answer('Эта кнопка устарела.', show_alert=True)
    await query.answer()
    await ask_cancel(query.message, state)


@router.callback_query(F.data.startswith('rent:cancel:'))
async def confirm_cancel_flow(query: CallbackQuery, state: FSMContext):
    current = await state.get_state()
    parts = query.data.split(':')
    data = await state.get_data()
    if (current not in {Rent.start.state, Rent.end.state, Rent.equipment.state, Rent.name.state, Rent.contact.state, Rent.review.state}
            or len(parts) != 4 or parts[2] not in {'yes', 'no'} or not data.get('cancel_nonce') or parts[3] != data['cancel_nonce']):
        return await query.answer('Эта кнопка устарела.', show_alert=True)
    if parts[2] == 'no':
        await state.update_data(cancel_nonce=None)
        await query.answer('Продолжаем оформление')
        return await query.message.answer('Продолжайте оформление с предыдущего шага.', reply_markup=flow_keyboard(contact=current == Rent.contact.state))
    await state.clear()
    await query.answer('Оформление отменено')
    await query.message.answer('Оформление отменено.', reply_markup=main_keyboard())


@router.callback_query(F.data == "rent:confirm")
async def confirm_booking(query: CallbackQuery, state: FSMContext, bot: Bot):
    if await state.get_state() != Rent.review.state:
        return await query.answer("Заявка уже отправлена или оформление завершено", show_alert=True)
    data = await state.get_data()
    await query.answer("Создаём заявку…")
    try:
        requested = [{"article_id": article_id, "quantity": data.get("quantities", {}).get(str(article_id), 1)} for article_id in data["ids"]]
        booking_id, created = await asyncio.to_thread(create_booking, query.from_user.id, data["name"], data["contact"], datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]), requested, data.get("request_id"), None, return_created=True)
    except (Conflict, ValueError) as exc:
        return await query.message.answer(f"Не удалось создать заявку: {exc}. Измените сроки или оборудование и попробуйте снова.")
    await state.clear()
    booking = await asyncio.to_thread(get_booking, booking_id)
    await query.message.answer(booking_created_text(booking), parse_mode=ParseMode.HTML, reply_markup=main_keyboard())
    if created:
        await notify_managers(bot, booking_id)


@fallback_router.message(F.text.regexp(r'(?i)^\s*(?:сегодня|завтра|\d{1,2}[./]\d{1,2}).*'))
async def orphaned_booking_date(message: Message, state: FSMContext):
    if message.chat and message.chat.type == 'private' and await state.get_state() is None:
        await message.answer('Не вижу незавершённого бронирования: возможно, бот перезапускался. Нажмите «Бронирование в чате», чтобы начать.', reply_markup=main_keyboard())


@router.message(Command("mybookings"))
@router.message(F.text == "Мои заявки")
async def my_bookings(message: Message):
    if not message.chat or message.chat.type != "private":
        return await message.answer("Откройте личный чат с ботом.")
    from .chat_workflows import customer_list
    await customer_list(message, message.from_user.id)


@router.message(Command("find"))
async def find_request(message: Message):
    _, _, number = (message.text or "").partition(" ")
    try:
        booking_id = await asyncio.to_thread(resolve_booking_number, number)
        booking = await asyncio.to_thread(get_booking, booking_id)
        if not booking or (booking.customer_id != message.from_user.id and not is_staff(message.from_user.id)):
            raise ValueError("Заявка не найдена")
        status = {"pending": "ожидает оператора", "confirmed": "подтверждена", "preparing": "подготавливается",
                  "ready": "готова к выдаче", "issued": "в аренде", "return_inspection": "проверка возврата",
                  "returned": "завершена", "cancelled": "отменена", "expired": "истекла"}.get(booking.status, "в обработке")
        await message.answer(f"Заявка {html.escape(booking.human_number)} · {status}")
    except ValueError:
        await message.answer("Заявка не найдена. Укажите полный номер или однозначные последние четыре цифры.")


@router.message(F.text == "Связаться с менеджером")
async def contact_manager(message: Message, state: FSMContext):
    if not message.chat or message.chat.type != "private":
        return await message.answer("Откройте личный чат с ботом.")
    await state.set_state(Support.message)
    await message.answer("Напишите вопрос одним сообщением. Не отправляйте в чат паспортные данные и фотографии документов. Для выхода нажмите «Отмена».", reply_markup=flow_keyboard())


@router.message(Support.message)
async def support_message(message: Message, state: FSMContext, bot: Bot):
    if not message.chat or message.chat.type != "private":
        await state.clear()
        return await message.answer("Откройте личный чат с ботом.")
    if not message.text or not message.text.strip():
        return await message.answer("Отправьте вопрос текстом.")
    try:
        result = await asyncio.to_thread(submit_question, message.from_user.id, None, "bot", message.text)
    except ValueError as exc:
        return await message.answer(str(exc))
    except Conflict:
        return await message.answer("Поддержка временно недоступна. Попробуйте позже.")
    if result["owner_id"]:
        await notify_actionable(None, result["owner_id"], "support_action", f"Новое обращение №{result['id']}. Откройте поддержку в Mini App.")
    await state.clear()
    await message.answer("Обращение получено.", reply_markup=main_keyboard())


@router.message(Command("reply"))
async def reply_to_customer(message: Message, bot: Bot):
    if not message.chat or message.chat.type != "private":
        return await message.answer("Откройте личный чат с ботом.")
    if message.from_user.id not in configured_ids("PII_ADMIN_IDS"):
        return
    try:
        _, thread_id, body = (message.text or "").split(" ", 2)
        message_id = await asyncio.to_thread(support_reply, int(thread_id), message.from_user.id, body)
        await deliver_reply(message_id)
        await message.answer("Ответ поставлен в очередь доставки.")
    except (ValueError, SupportConflict, Conflict):
        await message.answer("Формат: /reply НОМЕР_ОБРАЩЕНИЯ ТЕКСТ. Ответ доступен владельцу обращения.")


@router.message(Command("equipment"))
async def equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    items = await asyncio.to_thread(list_equipment)
    await message.answer("\n".join(f"{e.id}: {catalog_title(e.article.name, e.article.kind, e.article.brand, e.article.key_spec) if e.article else e.name} ({e.inventory_number}), {e.condition}" for e in items) or "Пусто")


@router.message(Command("add"))
async def add_equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    try:
        _, number, name = (message.text or "").split(" ", 2)
        item_id = await asyncio.to_thread(save_equipment, number, name, "", 0, "available")
        await message.answer(f"Экземпляр #{item_id} добавлен. Изменение и состояние доступны в веб-панели.")
    except IntegrityError:
        await message.answer("Экземпляр с таким серийным номером уже существует.")
    except (ValueError, Conflict, ClientBlocked) as exc:
        await message.answer(f"Формат: /add НОМЕР НАЗВАНИЕ. {exc}")


@router.message(Command("set"))
async def set_equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    try:
        _, identifier, number, condition, name = (message.text or "").split(" ", 4)
        item_id = await asyncio.to_thread(save_equipment, number, name, "", 0, condition, int(identifier))
        await message.answer(f"Экземпляр #{item_id} обновлен")
    except IntegrityError:
        await message.answer("Экземпляр с таким серийным номером уже существует.")
    except (ValueError, Conflict, ClientBlocked) as exc:
        await message.answer(f"Формат: /set ID НОМЕР available|maintenance|retired НАЗВАНИЕ. {exc}")


@router.message(Command("bookings"))
async def bookings(message: Message):
    if not message.chat or message.chat.type != "private":
        return await message.answer("Откройте личный чат с ботом.")
    from .chat_workflows import staff_list
    try:
        await staff_list(message, message.from_user.id)
    except ValueError as exc:
        await message.answer(str(exc))


@router.message(Command("confirm", "cancel", "prepare", "ready", "issue", "checkin", "return"))
async def change(message: Message, bot: Bot):
    if not is_admin(message.from_user.id):
        return
    command, _, number = (message.text or "").partition(" ")
    action = {"/confirm": "confirmed", "/cancel": "cancelled", "/prepare": "preparing",
              "/ready": "ready", "/issue": "issued", "/checkin": "return_inspection",
              "/return": "returned"}.get(command.split("@")[0])
    if not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        return await message.answer("Недостаточно прав для этого действия")
    try:
        key = number.strip()
        booking_id = int(key) if key.isascii() and key.isdigit() and len(key) != 4 else await asyncio.to_thread(resolve_booking_number, key)
        operator = (getattr(message.from_user, "full_name", "") or "").strip()
        operator = operator or (f"@{message.from_user.username}" if getattr(message.from_user, "username", None)
                                else "Сотрудник")
        status = await asyncio.to_thread(transition, booking_id, action, message.from_user.id, actor_name=operator)
        if status == "expired":
            return await message.answer("Удержание истекло; создайте новую заявку")
        booking = await asyncio.to_thread(get_booking, booking_id)
        update_text = booking_status_text(getattr(booking, "human_number", None) or booking_id, status, operator)
        await message.answer(update_text, parse_mode=ParseMode.HTML)
    except (ValueError, Conflict, ClientBlocked) as exc:
        await message.answer(f"Ошибка: {exc}. Формат: {command} НОМЕР")


async def main():
    validate_role_config()
    await asyncio.to_thread(init_db)
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        raise RuntimeError("BOT_TOKEN обязателен для запуска бота")
    bot = make_bot(token)
    if miniapp_url():
        try:
            await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Забронировать", web_app=WebAppInfo(url=miniapp_url())))
        except Exception as exc:
            logging.warning("Не удалось настроить меню Mini App: %s", exc)
    dp = Dispatcher()
    dp.message.outer_middleware(UserNameMiddleware())
    dp.callback_query.outer_middleware(UserNameMiddleware())
    dp.include_router(router)
    from .customer_changes_chat import router as customer_changes_router
    dp.include_router(customer_changes_router)
    from .chat_workflows import router as chat_workflows_router
    dp.include_router(chat_workflows_router)
    from .chat_catalog import router as chat_catalog_router
    dp.include_router(chat_catalog_router)
    from .chat_inventory import router as chat_inventory_router
    dp.include_router(chat_inventory_router)
    from .chat_settings import router as chat_settings_router
    dp.include_router(chat_settings_router)
    from .chat_admin import router as chat_admin_router
    dp.include_router(chat_admin_router)
    from .chat_deletions import router as chat_deletions_router
    dp.include_router(chat_deletions_router)
    dp.include_router(fallback_router)
    from .miniapp_server import deletion_loop, notification_loop
    notifications = asyncio.create_task(notification_loop())
    deletions = asyncio.create_task(deletion_loop())
    try:
        await dp.start_polling(bot)
    finally:
        notifications.cancel()
        deletions.cancel()
        from contextlib import suppress
        with suppress(asyncio.CancelledError):
            await notifications
        with suppress(asyncio.CancelledError):
            await deletions


if __name__ == "__main__":
    asyncio.run(main())
