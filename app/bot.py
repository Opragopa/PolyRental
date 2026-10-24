import asyncio
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import KeyboardButton, Message, ReplyKeyboardMarkup

from .db import init_db
from .service import Conflict, availability, create_booking, get_booking, list_bookings, list_equipment, save_equipment, transition

router = Router()
MOSCOW = ZoneInfo("Europe/Moscow")


def make_bot(token):
    proxy = os.getenv("HTTPS_PROXY") or os.getenv("https_proxy")
    return Bot(token, session=AiohttpSession(proxy=proxy) if proxy else None)


class Rent(StatesGroup):
    start = State()
    end = State()
    equipment = State()
    name = State()
    contact = State()


def parse_time(value):
    naive = datetime.strptime(value.strip(), "%d.%m.%Y %H:%M")
    return naive.replace(tzinfo=MOSCOW)


def is_admin(user_id):
    return str(user_id) in {v.strip() for v in os.getenv("ADMIN_IDS", "").split(",")}


def format_items(items):
    lines = []
    for item in items:
        status = "свободно" if item["available"] else (f'занято до {item["next_free"].astimezone(MOSCOW):%d.%m.%Y %H:%M}' if item["next_free"] else "недоступно")
        lines.append(f'{item["id"]}: {item["name"]} ({item["number"]}), {item["rate"]} ₽/час — {status}')
    return "\n".join(lines) or "Оборудование пока не добавлено"


@router.message(CommandStart())
async def start(message: Message):
    await message.answer("PolyRental. Чтобы подобрать оборудование на даты, нажмите «Бронировать» или отправьте /book.", reply_markup=ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text="Бронировать")]], resize_keyboard=True))


@router.message(Command("book"))
@router.message(F.text == "Бронировать")
async def book(message: Message, state: FSMContext):
    await state.set_state(Rent.start)
    await message.answer("Начало аренды по Москве (ДД.ММ.ГГГГ ЧЧ:ММ):")


@router.message(Rent.start)
async def rental_start(message: Message, state: FSMContext):
    try:
        start_at = parse_time(message.text or "")
    except ValueError:
        return await message.answer("Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ")
    await state.update_data(start=start_at.isoformat())
    await state.set_state(Rent.end)
    await message.answer("Дата и время возврата по Москве (ДД.ММ.ГГГГ ЧЧ:ММ):")


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
    await message.answer(format_items(items) + "\n\nОтправьте ID нужных свободных экземпляров через запятую.")


@router.message(Rent.equipment)
async def rental_equipment(message: Message, state: FSMContext):
    try:
        ids = sorted(set(int(part.strip()) for part in (message.text or "").split(",")))
        data = await state.get_data()
        items = await asyncio.to_thread(availability, datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]))
        if not ids or not set(ids).issubset({item["id"] for item in items if item["available"]}):
            raise ValueError()
    except ValueError:
        return await message.answer("Укажите ID свободных экземпляров через запятую")
    await state.update_data(ids=ids)
    await state.set_state(Rent.name)
    await message.answer("Как к вам обращаться? Введите имя для документов:")


@router.message(Rent.name)
async def rental_name(message: Message, state: FSMContext):
    if not message.text or not message.text.strip():
        return await message.answer("Введите имя")
    await state.update_data(name=message.text.strip())
    await state.set_state(Rent.contact)
    await message.answer("Введите телефон или другой контакт для менеджера:")


@router.message(Rent.contact)
async def rental_contact(message: Message, state: FSMContext, bot: Bot):
    data = await state.get_data()
    try:
        booking_id = await asyncio.to_thread(create_booking, message.from_user.id, data["name"], message.text or "", datetime.fromisoformat(data["start"]), datetime.fromisoformat(data["end"]), data["ids"])
    except (Conflict, ValueError) as exc:
        await state.clear()
        return await message.answer(f"Не удалось создать заявку: {exc}. Повторите /book.")
    await state.clear()
    await message.answer(f"Заявка №{booking_id} создана. Оборудование удерживается 30 минут, ожидайте подтверждения менеджера.")
    for admin_id in os.getenv("ADMIN_IDS", "").split(","):
        if admin_id.strip().isdigit():
            try:
                await bot.send_message(int(admin_id), f"Новая заявка №{booking_id}. /confirm {booking_id} или /cancel {booking_id}")
            except Exception:
                pass


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


@router.message(Command("confirm", "cancel", "issue", "return"))
async def change(message: Message, bot: Bot):
    if not is_admin(message.from_user.id):
        return
    command, _, number = (message.text or "").partition(" ")
    action = {"/confirm": "confirmed", "/cancel": "cancelled", "/issue": "issued", "/return": "returned"}.get(command.split("@")[0])
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
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
