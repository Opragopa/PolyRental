import asyncio
import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, MenuButtonWebApp, Message, ReplyKeyboardMarkup, WebAppInfo

from .db import init_db
from .miniapp import BookingRequest
from .service import Conflict, availability, booking_total, create_booking, get_booking, get_booking_by_request, list_bookings, list_customer_bookings, list_equipment, save_equipment, transition

router = Router()
MOSCOW = ZoneInfo("Europe/Moscow")


def make_bot(token):
    proxy = os.getenv("HTTPS_PROXY") or os.getenv("https_proxy")
    return Bot(token, session=AiohttpSession(proxy=proxy) if proxy else None)


def customer_label(booking):
    name = (booking.customer_name or "").strip()
    contact = (booking.customer_contact or "").strip()
    if contact.startswith("@") and contact.lower() not in name.lower():
        return f"{name} ({contact})" if name else contact
    return name or contact or f"Telegram ID {booking.customer_id}"


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
    naive = datetime.strptime(value.strip(), "%d.%m.%Y %H:%M")
    return naive.replace(tzinfo=MOSCOW)


def is_admin(user_id):
    return str(user_id) in {v.strip() for v in os.getenv("ADMIN_IDS", "").split(",")}


def format_items(items):
    lines = []
    for item in items:
        status = f'свободно: {item["available_quantity"]}' if item["available"] else "недоступно"
        lines.append(f'{item["id"]}: {item["name"]} ({item["sku"]}), {item["rate"]} ₽/час — {status}')
    return "\n".join(lines) or "Оборудование пока не добавлено"


def miniapp_url():
    url = os.getenv("PUBLIC_URL", "").rstrip("/")
    return f"{url}/miniapp" if url.startswith("https://") else None


def main_keyboard():
    app_url = miniapp_url()
    book_button = KeyboardButton(text="Забронировать", web_app=WebAppInfo(url=app_url)) if app_url else KeyboardButton(text="Забронировать")
    return ReplyKeyboardMarkup(keyboard=[[book_button], [KeyboardButton(text="Мои заявки"), KeyboardButton(text="Связаться с менеджером")]], resize_keyboard=True)


def flow_keyboard(contact=False):
    rows = [[KeyboardButton(text="Назад"), KeyboardButton(text="Отмена")]]
    if contact:
        rows.insert(0, [KeyboardButton(text="Поделиться телефоном", request_contact=True)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def equipment_keyboard(items, selected):
    buttons = [[InlineKeyboardButton(text=f'{"✓ " if item["id"] in selected else ""}{item["name"]} · {item["rate"]} ₽/ч', callback_data=f'rent:toggle:{item["id"]}')] for item in items]
    buttons.append([InlineKeyboardButton(text="Продолжить →", callback_data="rent:next")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


async def notify_managers(bot, booking_id):
    booking = await asyncio.to_thread(get_booking, booking_id)
    label = customer_label(booking) if booking else "клиент"
    for admin_id in os.getenv("ADMIN_IDS", "").split(","):
        if admin_id.strip().isdigit():
            try:
                await bot.send_message(int(admin_id), f"Новая заявка №{booking_id} от {label}. /confirm {booking_id} или /cancel {booking_id}")
            except Exception:
                pass


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
    selected = set(data.get("ids", [])) & {item["id"] for item in available}
    await state.update_data(ids=sorted(selected))
    await message.answer("Выберите модели оборудования кнопками. В этом резервном сценарии одна кнопка добавляет одну единицу; количество удобнее менять в Mini App.", reply_markup=flow_keyboard())
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
    if len(chosen) != len(data["ids"]) or any(not item["available"] for item in chosen):
        await state.set_state(Rent.equipment)
        await message.answer("Выбранное оборудование уже занято. Выберите другое или измените сроки.", reply_markup=flow_keyboard())
        return await show_equipment(message, state)
    total = booking_total(start_at, end_at, (item["rate"] for item in chosen))
    await state.update_data(expected_total=str(total), editing=None)
    text = (f"Проверьте заявку:\n{start_at.astimezone(MOSCOW):%d.%m.%Y %H:%M} — {end_at.astimezone(MOSCOW):%d.%m.%Y %H:%M} МСК\n"
            f"Оборудование: {', '.join(item['name'] for item in chosen)}\nИмя: {data['name']}\nКонтакт: {data['contact']}\n"
            f"Итого: {total} ₽\nУдержание начнётся после подтверждения и продлится 30 минут.")
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Подтвердить бронирование", callback_data="rent:confirm")],
        [InlineKeyboardButton(text="Изменить сроки", callback_data="rent:edit:start"), InlineKeyboardButton(text="Изменить оборудование", callback_data="rent:edit:equipment")],
        [InlineKeyboardButton(text="Изменить имя", callback_data="rent:edit:name"), InlineKeyboardButton(text="Изменить контакт", callback_data="rent:edit:contact")],
        [InlineKeyboardButton(text="Отмена", callback_data="rent:cancel")],
    ])
    await message.answer(text, reply_markup=keyboard)


@router.message(CommandStart())
async def start(message: Message, state: FSMContext):
    await state.clear()
    text = "PolyRental. Нажмите «Забронировать», чтобы выбрать сроки и оборудование."
    if not miniapp_url():
        text += " Пока PUBLIC_URL не указывает на HTTPS, бронирование доступно в чате."
    await message.answer(text, reply_markup=main_keyboard())


@router.message(Command("book"))
@router.message(F.text == "Забронировать")
async def book(message: Message, state: FSMContext):
    if miniapp_url():
        await message.answer("Откройте удобную форму бронирования или продолжите в чате.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Открыть приложение", web_app=WebAppInfo(url=miniapp_url()))],
            [InlineKeyboardButton(text="Бронировать в чате", callback_data="rent:chat")],
        ]))
        return
    await begin_chat_booking(message, state)


@router.message(F.web_app_data)
async def booking_from_miniapp(message: Message, bot: Bot):
    if message.chat.type != "private" or not message.from_user:
        return
    raw = message.web_app_data.data
    if len(raw.encode()) > 4096:
        return await message.answer("Заявка слишком большая. Откройте приложение и попробуйте ещё раз.")
    try:
        payload = BookingRequest.model_validate_json(raw)
        previous = await asyncio.to_thread(get_booking_by_request, message.from_user.id, str(payload.request_id))
        booking_id = await asyncio.to_thread(
            create_booking, message.from_user.id, payload.name.strip(), payload.contact.strip(), payload.start,
            payload.end, [line.model_dump() for line in payload.lines], str(payload.request_id), payload.expected_total,
        )
    except (ValueError, Conflict) as exc:
        return await message.answer(f"Не удалось создать заявку: {exc}. Откройте приложение и проверьте сроки, оборудование и контакты.", reply_markup=main_keyboard())
    await message.answer(f"Заявка №{booking_id} создана. Оборудование удерживается 30 минут, ожидайте подтверждения менеджера.", reply_markup=main_keyboard())
    if not previous:
        await notify_managers(bot, booking_id)


async def begin_chat_booking(message, state):
    await state.clear()
    await state.set_state(Rent.start)
    await message.answer("Когда получите оборудование? Введите дату и время по Москве: ДД.ММ.ГГГГ ЧЧ:ММ", reply_markup=flow_keyboard())


@router.message(Command("book_chat"))
async def book_chat(message: Message, state: FSMContext):
    await begin_chat_booking(message, state)


@router.callback_query(F.data == "rent:chat")
async def book_chat_button(query: CallbackQuery, state: FSMContext):
    await query.answer()
    await begin_chat_booking(query.message, state)


@router.message(F.text == "Отмена")
@router.message(Command("cancel_booking"))
async def cancel_flow(message: Message, state: FSMContext):
    await state.clear()
    await message.answer("Оформление отменено. Можно начать заново в любое время.", reply_markup=main_keyboard())


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
        return await message.answer("Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ")
    await state.update_data(start=start_at.isoformat())
    await state.set_state(Rent.end)
    await message.answer("Когда вернёте оборудование? Введите дату и время по Москве: ДД.ММ.ГГГГ ЧЧ:ММ", reply_markup=flow_keyboard())


@router.message(Rent.end)
async def rental_end(message: Message, state: FSMContext):
    try:
        end_at = parse_time(message.text or "")
        start_at = datetime.fromisoformat((await state.get_data())["start"])
        items = await asyncio.to_thread(availability, start_at, end_at)
    except ValueError as exc:
        return await message.answer(str(exc))
    await state.update_data(end=end_at.isoformat())
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
        return await message.answer("Выберите оборудование кнопками под списком или укажите ID свободных экземпляров через запятую.")
    await state.update_data(ids=ids)
    if data.get("editing") in {"start", "equipment"} and data.get("name") and data.get("contact"):
        await state.set_state(Rent.review)
        return await show_review(message, state)
    await state.set_state(Rent.name)
    await message.answer("Как к вам обращаться? Введите имя для документов:", reply_markup=flow_keyboard())


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
    prompts = {"start": "Введите новую дату и время выдачи по Москве: ДД.ММ.ГГГГ ЧЧ:ММ", "name": "Введите новое имя:", "contact": "Введите новый телефон или Telegram:"}
    await query.message.answer(prompts[target], reply_markup=flow_keyboard(contact=target == "contact"))


@router.callback_query(F.data == "rent:cancel")
async def cancel_review(query: CallbackQuery, state: FSMContext):
    await state.clear(); await query.answer("Оформление отменено")
    await query.message.answer("Оформление отменено.", reply_markup=main_keyboard())


@router.callback_query(F.data == "rent:confirm")
async def confirm_booking(query: CallbackQuery, state: FSMContext, bot: Bot):
    if await state.get_state() != Rent.review.state:
        return await query.answer("Заявка уже отправлена или оформление завершено", show_alert=True)
    data = await state.get_data()
    await query.answer("Создаём заявку…")
    try:
        requested = [{"article_id": article_id, "quantity": 1} for article_id in data["ids"]]
        booking_id = await asyncio.to_thread(create_booking, query.from_user.id, data["name"], data["contact"], datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]), requested, None, data.get("expected_total"))
    except (Conflict, ValueError) as exc:
        return await query.message.answer(f"Не удалось создать заявку: {exc}. Измените сроки или оборудование и попробуйте снова.")
    await state.clear()
    await query.message.answer(f"Заявка №{booking_id} создана. Оборудование удерживается 30 минут, ожидайте подтверждения менеджера.", reply_markup=main_keyboard())
    await notify_managers(bot, booking_id)


@router.message(Command("mybookings"))
@router.message(F.text == "Мои заявки")
async def my_bookings(message: Message):
    bookings = await asyncio.to_thread(list_customer_bookings, message.from_user.id)
    if not bookings:
        return await message.answer("Заявок пока нет. Нажмите «Забронировать», чтобы начать.", reply_markup=main_keyboard())
    names = {"pending": "ждёт менеджера", "confirmed": "подтверждена — заполните документы",
             "preparing": "комплектуется", "ready": "готова к выдаче", "issued": "в аренде",
             "return_inspection": "проверяется после возврата", "returned": "завершена",
             "cancelled": "отменена", "expired": "удержание истекло"}
    lines = []
    for booking in bookings[:10]:
        lines.append(f"№{booking.id} · {names.get(booking.status, booking.status)} · {booking.starts_at.astimezone(MOSCOW):%d.%m %H:%M}–{booking.ends_at.astimezone(MOSCOW):%d.%m %H:%M} МСК")
    await message.answer("Ваши заявки:\n" + "\n".join(lines), reply_markup=main_keyboard())


@router.message(F.text == "Связаться с менеджером")
async def contact_manager(message: Message, state: FSMContext):
    await state.set_state(Support.message)
    await message.answer("Напишите вопрос одним сообщением. Я передам его менеджеру. Для выхода нажмите «Отмена».", reply_markup=flow_keyboard())


@router.message(Support.message)
async def support_message(message: Message, state: FSMContext, bot: Bot):
    if not message.text or not message.text.strip():
        return await message.answer("Отправьте вопрос текстом.")
    name = message.from_user.full_name or "Клиент"
    for admin_id in os.getenv("ADMIN_IDS", "").split(","):
        if admin_id.strip().isdigit():
            try:
                await bot.send_message(int(admin_id), f"Вопрос от {name} (Telegram ID {message.from_user.id}):\n{message.text}\nОтветить: /reply {message.from_user.id} ТЕКСТ")
            except Exception:
                pass
    await state.clear()
    await message.answer("Вопрос передан менеджеру.", reply_markup=main_keyboard())


@router.message(Command("reply"))
async def reply_to_customer(message: Message, bot: Bot):
    if not is_admin(message.from_user.id):
        return
    try:
        _, customer_id, body = (message.text or "").split(" ", 2)
        await bot.send_message(int(customer_id), f"Ответ менеджера PolyRental:\n{body}")
        await message.answer("Ответ отправлен.")
    except Exception:
        await message.answer("Формат: /reply TELEGRAM_ID ТЕКСТ")


@router.message(Command("equipment"))
async def equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    items = await asyncio.to_thread(list_equipment)
    await message.answer("\n".join(f"{e.id}: {e.name} ({e.inventory_number}), {e.hourly_rate} ₽/час, {e.condition}" for e in items) or "Пусто")


@router.message(Command("add"))
async def add_equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    try:
        _, number, rate, name = (message.text or "").split(" ", 3)
        item_id = await asyncio.to_thread(save_equipment, number, name, "", rate, "available")
        await message.answer(f"Экземпляр #{item_id} добавлен. Изменение и состояние доступны в веб-панели.")
    except (ValueError, Conflict) as exc:
        await message.answer(f"Формат: /add НОМЕР ЦЕНА_ЗА_ЧАС НАЗВАНИЕ. {exc}")


@router.message(Command("set"))
async def set_equipment(message: Message):
    if not is_admin(message.from_user.id):
        return
    try:
        _, identifier, number, rate, condition, name = (message.text or "").split(" ", 5)
        item_id = await asyncio.to_thread(save_equipment, number, name, "", rate, condition, int(identifier))
        await message.answer(f"Экземпляр #{item_id} обновлен")
    except (ValueError, Conflict) as exc:
        await message.answer(f"Формат: /set ID НОМЕР ЦЕНА available|maintenance|retired НАЗВАНИЕ. {exc}")


@router.message(Command("bookings"))
async def bookings(message: Message):
    if not is_admin(message.from_user.id):
        return
    data = await asyncio.to_thread(list_bookings)
    await message.answer("\n".join(f"#{b.id} {b.status} {b.customer_name}: {b.starts_at.astimezone(MOSCOW):%d.%m %H:%M}–{b.ends_at.astimezone(MOSCOW):%d.%m %H:%M}" for b in data[:30]) or "Заявок нет")


@router.message(Command("confirm", "cancel", "prepare", "ready", "issue", "checkin", "return"))
async def change(message: Message, bot: Bot):
    if not is_admin(message.from_user.id):
        return
    command, _, number = (message.text or "").partition(" ")
    action = {"/confirm": "confirmed", "/cancel": "cancelled", "/prepare": "preparing",
              "/ready": "ready", "/issue": "issued", "/checkin": "return_inspection",
              "/return": "returned"}.get(command.split("@")[0])
    try:
        booking_id = int(number.strip())
        status = await asyncio.to_thread(transition, booking_id, action, message.from_user.id)
        if status == "expired":
            return await message.answer("Удержание истекло; создайте новую заявку")
        await message.answer(f"Заявка #{booking_id}: {status}")
        booking = await asyncio.to_thread(get_booking, booking_id)
        await bot.send_message(booking.customer_id, f"Статус заявки №{booking_id}: {status}")
    except (ValueError, Conflict) as exc:
        await message.answer(f"Ошибка: {exc}. Формат: {command} НОМЕР")


async def main():
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
    dp.include_router(router)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
