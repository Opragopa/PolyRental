"""Chat workflows using the same booking services as the Mini App."""
import asyncio
import html
import os
import re
import secrets
from datetime import datetime
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo
from urllib.parse import urlencode

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.enums import ParseMode
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from .handover import customer_attest, handover_state
from .rental import Conflict, customer_history_page, get_booking, transition
from .roles import staff_allows

router = Router(name="chat_workflows")
PAGE_SIZE = 6
MOSCOW = ZoneInfo("Europe/Moscow")


class ManagerEdit(StatesGroup):
    dates = State()
    lines = State()
    comment = State()
    confirm = State()


class StaffWorkflow(StatesGroup):
    comment = State()
    confirm = State()


class StaffAssignment(StatesGroup):
    choose = State()
    components = State()
    note = State()
    confirm = State()


class CustomerAttestation(StatesGroup):
    reading = State()


class CustomerEdit(StatesGroup):
    dates = State()
    lines = State()
    confirm = State()


class CustomerDispute(StatesGroup):
    comment = State()
    confirm = State()


class QuietHours(StatesGroup):
    input = State()
    confirm = State()


class StaffInspection(StatesGroup):
    choose = State()
    defect = State()
    notes = State()
    cost = State()
    charge = State()
    confirm = State()
    photo = State()


def button(label, callback):
    return InlineKeyboardButton(text=label, callback_data=callback)


def app_button(label, booking_id):
    base = os.getenv("PUBLIC_URL", "").rstrip("/")
    if not base.startswith("https://"):
        return None
    return InlineKeyboardButton(text=label, web_app=WebAppInfo(url=f"{base}/miniapp?{urlencode({'booking': booking_id})}"))


def private(event):
    message = event.message if isinstance(event, CallbackQuery) else event
    return bool(message and message.chat and message.chat.type == "private" and event.from_user)


def number(booking):
    return html.escape(booking.human_number or str(booking.id))


async def customer_list(message: Message, customer_id: int, page: int = 0):
    page = max(0, min(page, 100000))
    bookings, total = await asyncio.to_thread(customer_history_page, customer_id, "all", page, PAGE_SIZE, "", None)
    rows = [[button(f"{booking.human_number or booking.id} · {booking.status}", f"cw:open:{booking.id}")] for booking in bookings]
    navigation = []
    if page: navigation.append(button("← Назад", f"cw:page:{page-1}"))
    if (page + 1) * PAGE_SIZE < total: navigation.append(button("Далее →", f"cw:page:{page+1}"))
    if navigation: rows.append(navigation)
    if not rows:
        return await message.answer("Заявок пока нет. Нажмите «Забронировать», чтобы начать.")
    await message.answer(f"Ваши заявки · страница {page+1}\nМои обращения: /my_support · Напоминания: /reminders", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def owned_booking(booking_id, user_id):
    booking = await asyncio.to_thread(get_booking, booking_id)
    if not booking or booking.customer_id != user_id:
        raise ValueError("Заявка не найдена")
    return booking


async def show_customer_booking(message, booking_id, user_id):
    booking = await owned_booking(booking_id, user_id)
    lines = "\n".join(f"• {html.escape(line.article.name)} × {line.quantity}" for line in booking.lines)
    text = f"<b>Заявка {number(booking)}</b>\nСтатус: {html.escape(booking.status)}\nОборудование:\n{lines or 'Нет позиций'}"
    rows = []
    if booking.status in {"pending", "confirmed", "needs_changes"}:
        rows.append([button("Отменить заявку", f"cw:askcancel:{booking.id}")])
    if booking.status == "pending":
        rows.append([button("Изменить заявку", f"cw:edit:{booking.id}")])
    if booking.status == "needs_changes":
        rows.append([button("Посмотреть предложенные изменения", f"cw:changes:{booking.id}")])
    if booking.status in {"ready", "issued", "return_inspection"}:
        rows.append([button("Подтвердить получение" if booking.status == "ready" else "Сдаю оборудование", f"cw:askattest:{booking.id}:{'received' if booking.status == 'ready' else 'returning'}")])
    secure = app_button("Открыть заявку и документы", booking.id)
    if secure: rows.append([secure])
    rows.append([button("К списку заявок", "cw:page:0")])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith("cw:"))
async def customer_action(query: CallbackQuery, state: FSMContext):
    if not private(query):
        return await query.answer("Откройте личный чат с ботом", show_alert=True)
    parts = query.data.split(":")
    try:
        action = parts[1]
        if action == "page" and len(parts) == 3:
            await query.answer(); return await customer_list(query.message, query.from_user.id, int(parts[2]))
        if len(parts) < 3: raise ValueError("Действие недоступно")
        booking_id = int(parts[2]); booking = await owned_booking(booking_id, query.from_user.id)
        if action == "open":
            await query.answer(); return await show_customer_booking(query.message, booking_id, query.from_user.id)
        if action == "askcancel":
            await query.answer()
            return await query.message.answer("Отменить заявку?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Да, отменить", f"cw:cancel:{booking_id}"), button("Назад", f"cw:open:{booking_id}")]]))
        if action == "cancel":
            await asyncio.to_thread(transition, booking_id, "cancelled", query.from_user.id, query.from_user.id)
            await query.answer("Заявка отменена")
            return await show_customer_booking(query.message, booking_id, query.from_user.id)
        if action == "askattest" and len(parts) == 4 and parts[3] in {"received", "returning"}:
            if parts[3] == "received": return await begin_customer_receipt(query,state,booking_id)
            await query.answer()
            return await query.message.answer("Подтверждаете, что сдаёте оборудование?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Подтверждаю", f"cw:attest:{booking_id}:returning"), button("Назад", f"cw:open:{booking_id}")]]))
        if action == "attest" and len(parts) == 4 and parts[3] == "returning":
            await asyncio.to_thread(customer_attest, booking_id, query.from_user.id, "returning", False)
            await query.answer("Подтверждение сохранено")
            return await show_customer_booking(query.message, booking_id, query.from_user.id)
        if action == "receiptpage" and len(parts) == 5:
            return await customer_receipt_page(query,state,booking_id,parts[3],int(parts[4]))
        if action == "receiptconfirm" and len(parts) == 4:
            return await customer_receipt_confirm(query,state,booking_id,parts[3])
        if action == "edit" and len(parts) == 3:
            return await begin_customer_edit(query,state,booking,None)
        if action == "fix" and len(parts) == 4:
            return await begin_customer_edit(query,state,booking,int(parts[3]))
        if action == "editsave" and len(parts) == 4:
            return await customer_edit_save(query,state,booking_id,parts[3])
        if action == "dispute" and len(parts) == 4:
            change_id=int(parts[3])
            from .booking_changes import change_view
            change=await asyncio.to_thread(change_view,booking_id,query.from_user.id)
            if not change or change['id']!=change_id or change['status']!='pending' or change['change_type']!='manager_edit':
                raise Conflict("Предложение изменилось. Откройте заявку заново")
            await state.clear();await state.update_data(dispute_booking=booking_id,dispute_change=change_id)
            await state.set_state(CustomerDispute.comment);await query.answer()
            return await query.message.answer("Напишите причину оспаривания до 2000 символов. Не отправляйте паспортные данные и фотографии документов. Отмена: /cancel_booking.")
        if action == "disputesave" and len(parts) == 4:
            return await customer_dispute_confirm(query,state,booking_id,parts[3])
        if action == "changes":
            from .booking_changes import change_view
            change = await asyncio.to_thread(change_view, booking_id, query.from_user.id)
            if change and change["status"] == "pending" and change["change_type"] == "client_fix":
                rows = [[button("Исправить заявку", f"cw:fix:{booking_id}:{change['id']}")]]
                secure = app_button("Прочитать комментарий", booking_id)
                if secure: rows.append([secure])
                await query.answer()
                return await query.message.answer("Менеджер запросил исправление. Прочитайте комментарий в защищённой заявке, затем исправьте сроки и состав.", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
            if not change or change["status"] != "pending" or change["change_type"] != "manager_edit":
                secure = app_button("Открыть заявку", booking_id)
                await query.answer("Откройте заявку для продолжения")
                return await query.message.answer("Для этого изменения требуется открыть заявку в приложении.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[secure]]) if secure else None)
            before, after = change["before"], change["after"]
            text = "<b>Предложенные изменения</b>\nБыло: " + html.escape(str(before.get("start", ""))) + " — " + html.escape(str(before.get("end", "")))
            text += "\nСтало: " + html.escape(str(after.get("start", ""))) + " — " + html.escape(str(after.get("end", "")))
            old_lines = {line["article_id"]: line for line in before.get("lines", [])}
            new_lines = {line["article_id"]: line for line in after.get("lines", [])}
            for article_id in old_lines.keys() | new_lines.keys():
                old, new = old_lines.get(article_id, {}), new_lines.get(article_id, {})
                text += "\n• " + html.escape(str(new.get("name") or old.get("name") or "Оборудование")) + f" · {int(old.get('quantity', 0))} → {int(new.get('quantity', 0))}"
            text += "\nПеред подтверждением прочитайте комментарий в защищённой заявке."
            secure = app_button("Оспорить или исправить", booking_id)
            rows = [[button("Ознакомлен, принимаю", f"cw:accept:{booking_id}:{change['id']}")], [button("Оспорить", f"cw:dispute:{booking_id}:{change['id']}")]]
            if secure: rows.append([secure])
            await query.answer(); return await query.message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        if action == "accept" and len(parts) == 4:
            from .booking_changes import update_request
            await asyncio.to_thread(update_request, booking_id, query.from_user.id, None, None, None, int(parts[3]), True, "")
            await query.answer("Изменения приняты")
            return await show_customer_booking(query.message, booking_id, query.from_user.id)
        raise ValueError("Действие недоступно")
    except (ValueError, Conflict, PermissionError) as exc:
        await query.answer(str(exc)[:180], show_alert=True)

async def staff_list(message, user_id, page=0):
    from .rental import list_bookings
    if not await asyncio.to_thread(staff_allows, user_id, "operator"):
        raise ValueError("Доступ только для сотрудников")
    page = max(0, min(page, 33))
    bookings = await asyncio.to_thread(list_bookings)
    rows = [[button(f"{booking.human_number or booking.id} · {booking.status}", f"sw:open:{booking.id}")] for booking in bookings[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"sw:page:{page-1}"))
    if (page + 1) * PAGE_SIZE < len(bookings): nav.append(button("Далее →", f"sw:page:{page+1}"))
    if nav: rows.append(nav)
    if not rows: return await message.answer("Заявок нет.")
    await message.answer(f"Очередь заявок · страница {page+1}\nПоиск: /find НОМЕР\nКаталог: /catalog · Ремонты: /repairs · Поддержка: /support · Тихие часы: /quiet · Сотрудники: /staff_settings · Скрытые тестовые: /hidden_tests", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def show_staff_booking(message, booking_id, user_id):
    if not await asyncio.to_thread(staff_allows, user_id, "operator"):
        raise ValueError("Доступ только для сотрудников")
    booking = await asyncio.to_thread(get_booking, booking_id)
    if not booking: raise ValueError("Заявка не найдена")
    lines = "\n".join(f"• {html.escape(line.article.name)} × {line.quantity}" for line in booking.lines)
    text = f"<b>Заявка {number(booking)}</b>\nСтатус: {html.escape(booking.status)}\nОборудование:\n{lines or 'Нет позиций'}"
    transitions = {"pending": [("Подтвердить", "confirmed")], "confirmed": [("Начать подготовку", "preparing")],
                   "preparing": [("Готова к выдаче", "ready")], "ready": [("Выдать", "issued")],
                   "issued": [("Начать приёмку", "return_inspection")], "return_inspection": [("Завершить заявку", "returned")]}
    rows = [[button(label, f"sw:ask:{booking_id}:{action}")] for label, action in transitions.get(booking.status, [])]
    manager = await asyncio.to_thread(staff_allows, user_id, "manager")
    if manager and booking.status in {"pending", "needs_changes", "confirmed", "preparing", "ready", "issued", "return_inspection"}:
        rows.append([button("Назначить ответственного", f"wf:assignees:{booking_id}:0")])
    if await asyncio.to_thread(staff_allows, user_id, "admin"):
        rows.append([button("Тестовая отметка и доступ клиента", f"am:booking:{booking_id}")])
    if booking.is_test:
        rows.append([button("Скрыть тестовую заявку", f"am:hide:{booking_id}")])
    if booking.status in {"pending", "confirmed"} and manager:
        rows.append([button("Изменить сроки и состав", f"sw:edit:{booking_id}"), button("Запросить исправление", f"wf:fix:{booking_id}")])
    if manager and booking.status in {"pending", "needs_changes", "confirmed"}:
        rows.append([button("Отклонить заявку", f"wf:decline:{booking_id}")])
    if booking.status in {"confirmed", "preparing", "ready", "return_inspection"}:
        rows.append([button("Вернуть на доработку", f"wf:rework:{booking_id}")])
    if booking.status == "return_inspection" and booking.assets:
        rows.append([button("Результат при возврате", f"wf:findings:{booking_id}:0")])
    if booking.status in {"pending", "cancelled", "expired"}:
        rows.append([button("Удалить заявку", f"dl:ask:request:{booking_id}:0")])
    if booking.status == "pending" and booking.lines:
        rows.append([button("Удалить позицию", f"dl:list:line:{booking_id}:0")])
    if booking.status == "preparing" and booking.assets:
        rows.append([button("Удалить экземпляр", f"dl:list:asset:{booking_id}:0")])
    if booking.status in {"confirmed", "preparing"}:
        rows.append([button("Назначить экземпляры", f"sw:assign:{booking_id}")])
    if booking.status in {"preparing", "return_inspection"} and booking.assets:
        rows.append([button("Проверить экземпляры", f"sw:inspect:{booking_id}")])
    secure = app_button("Открыть заявку в Mini App", booking_id)
    if secure: rows.append([secure])
    rows.append([button("К очереди", "sw:page:0")])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith("sw:"))
async def staff_action(query: CallbackQuery, state: FSMContext):
    if not private(query): return await query.answer("Откройте личный чат с ботом", show_alert=True)
    if not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников", show_alert=True)
    try:
        parts = query.data.split(":")
        if parts[1] == "page" and len(parts) == 3:
            await query.answer(); return await staff_list(query.message, query.from_user.id, int(parts[2]))
        if parts[1] == "open" and len(parts) == 3:
            await query.answer(); return await show_staff_booking(query.message, int(parts[2]), query.from_user.id)
        if parts[1] == "inspect" and len(parts) in {3, 4}:
            await query.answer()
            return await inspection_list(query.message, int(parts[2]), query.from_user.id, int(parts[3]) if len(parts) == 4 else 0)
        if parts[1] == "inspection" and len(parts) == 4:
            await start_inspection(query, state, int(parts[2]), int(parts[3]))
            return
        if parts[1] in {"inspectionpass", "inspectionfail", "inspectioncharge", "inspectionsave"}:
            return await inspection_action(query, state, parts)
        if parts[1] == "assign" and len(parts) == 3:
            booking = await asyncio.to_thread(get_booking, int(parts[2]))
            if not booking or booking.status not in {"confirmed", "preparing"}:
                raise Conflict("Комплектация доступна для подтверждённой заявки")
            await state.clear(); await state.update_data(booking_id=booking.id)
            await state.set_state(StaffAssignment.choose)
            details = "\n".join(f"Строка {row.id} · {html.escape(row.article.name)} · {row.quantity} шт." for row in booking.lines)
            await query.answer()
            return await query.message.answer("Назначение экземпляров:\n" + details + "\n\nОтправьте − для автоматического подбора или укажите все строки: строка:ID,нет,неисправен,замена=ID; строка:ID. Для каждой позиции нужен один вариант. Список ID: /equipment. Отмена: /cancel_booking.", parse_mode=ParseMode.HTML)
        if parts[1] == "assignconfirm" and len(parts) == 4:
            lock = _assignment_locks.setdefault(query.from_user.id, asyncio.Lock())
            async with lock:
                data = await state.get_data()
                if await state.get_state() != StaffAssignment.confirm.state or data.get("booking_id") != int(parts[2]) or data.get("assignment_nonce") != parts[3]:
                    raise Conflict("Выбор устарел. Откройте заявку заново")
                if not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
                    raise PermissionError("Доступ только для сотрудников")
                from .rental import assign_booking_assets
                actor = (getattr(query.from_user, "full_name", "") or "").strip() or f"оператор {query.from_user.id}"
                await asyncio.to_thread(assign_booking_assets, data["booking_id"], query.from_user.id, data["assignments"], actor, data.get("exceptions"))
                await state.clear(); await query.answer("Экземпляры назначены")
                return await show_staff_booking(query.message, data["booking_id"], query.from_user.id)
        if parts[1] == "edit" and len(parts) == 3:
            if not await asyncio.to_thread(staff_allows, query.from_user.id, "manager"):
                raise ValueError("Для изменения заявки нужна роль менеджера")
            booking = await asyncio.to_thread(get_booking, int(parts[2]))
            if not booking or booking.status not in {"pending", "confirmed"}:
                raise Conflict("Изменение доступно до начала подготовки")
            before = {"start": booking.starts_at.isoformat(), "end": booking.ends_at.isoformat(), "lines": sorted([{"article_id": row.article_id, "quantity": row.quantity, "name": row.article.name} for row in booking.lines], key=lambda row: row["article_id"])}
            await state.clear(); await state.update_data(booking_id=booking.id, before=before)
            await state.set_state(ManagerEdit.dates)
            await query.answer()
            return await query.message.answer("Введите даты по Москве: ДД.ММ.ГГГГ ЧЧ:ММ | ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы сохранить текущие сроки, отправьте −. Для отмены: /cancel_booking.")
        if parts[1] == "editconfirm" and len(parts) == 3:
            if not await asyncio.to_thread(staff_allows, query.from_user.id, "manager"):
                raise ValueError("Для изменения заявки нужна роль менеджера")
            data = await state.get_data()
            if await state.get_state() != ManagerEdit.confirm.state or data.get("booking_id") != int(parts[2]):
                raise Conflict("Редактирование завершено или устарело. Откройте заявку заново")
            from .booking_changes import propose_change
            await asyncio.to_thread(propose_change, data["booking_id"], query.from_user.id, "manager_edit", data["comment"], data["proposed"], data["before"])
            await state.clear(); await query.answer("Изменения отправлены клиенту")
            return await show_staff_booking(query.message, data["booking_id"], query.from_user.id)
        allowed = {"confirmed", "preparing", "ready", "issued", "return_inspection", "returned"}
        if len(parts) != 4 or parts[3] not in allowed: raise ValueError("Действие недоступно")
        booking_id, target = int(parts[2]), parts[3]
        if parts[1] == "ask":
            await query.answer()
            return await query.message.answer("Подтвердить изменение статуса заявки?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Подтвердить", f"sw:do:{booking_id}:{target}"), button("Назад", f"sw:open:{booking_id}")]]))
        if parts[1] == "do":
            actor = (getattr(query.from_user, "full_name", "") or "").strip() or f"оператор {query.from_user.id}"
            await asyncio.to_thread(transition, booking_id, target, query.from_user.id, actor_name=actor)
            await query.answer("Статус изменён")
            return await show_staff_booking(query.message, booking_id, query.from_user.id)
        raise ValueError("Действие недоступно")
    except (ValueError, Conflict, PermissionError) as exc:
        await query.answer(str(exc)[:180], show_alert=True)


async def manager_edit_allowed(message, state):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "manager"):
        await state.clear()
        await message.answer("Редактирование доступно менеджеру в личном чате.")
        return False
    return True


@router.message(ManagerEdit.dates)
async def manager_edit_dates(message: Message, state: FSMContext):
    if not await manager_edit_allowed(message, state): return
    data = await state.get_data()
    try:
        value = (message.text or "").strip()
        if value in {"-", "−"}:
            start, end = datetime.fromisoformat(data["before"]["start"]), datetime.fromisoformat(data["before"]["end"])
        else:
            first, last = value.split("|")
            start = datetime.strptime(first.strip(), "%d.%m.%Y %H:%M").replace(tzinfo=MOSCOW)
            end = datetime.strptime(last.strip(), "%d.%m.%Y %H:%M").replace(tzinfo=MOSCOW)
        from .rental import validate_interval, availability
        await asyncio.to_thread(validate_interval, start, end, enforce_booking_notice=True)
        items = await asyncio.to_thread(availability, start, end)
    except ValueError as exc:
        return await message.answer(f"Не удалось проверить сроки: {exc}. Введите две даты через | или −.")
    lines = [{"article_id": row["article_id"], "quantity": row["quantity"]} for row in data["before"]["lines"]]
    await state.update_data(proposed={"start": start.isoformat(), "end": end.isoformat(), "lines": lines})
    await state.set_state(ManagerEdit.lines)
    examples = "\n".join(f"{item['id']} · {html.escape(item.get('title') or item['name'])} · доступно {item['available_quantity']}" for item in items[:20])
    await message.answer("Отправьте полный состав в формате ID:количество, например 12:2, 18:1. Чтобы сохранить состав, отправьте −. Для поиска отправьте название.\n\n" + (examples or "Каталог пуст."), parse_mode=ParseMode.HTML)


@router.message(ManagerEdit.lines)
async def manager_edit_lines(message: Message, state: FSMContext):
    if not await manager_edit_allowed(message, state): return
    data = await state.get_data(); text = (message.text or "").strip()
    if text not in {"-", "−"}:
        if not re.fullmatch(r"\s*\d+\s*:\s*\d+(\s*,\s*\d+\s*:\s*\d+)*\s*", text):
            from .rental import availability
            proposed = data["proposed"]
            try:
                items = await asyncio.to_thread(availability, datetime.fromisoformat(proposed["start"]), datetime.fromisoformat(proposed["end"]))
            except ValueError as exc:
                return await message.answer(f"Не удалось загрузить каталог: {exc}")
            query = text.casefold()
            found = [item for item in items if query and query in " ".join(str(item.get(k) or "") for k in ("title", "name", "sku", "brand")).casefold()]
            result = "\n".join(f"{item['id']} · {html.escape(item.get('title') or item['name'])} · доступно {item['available_quantity']}" for item in found[:20])
            return await message.answer(result or "Ничего не найдено. Введите название или состав в формате ID:количество.", parse_mode=ParseMode.HTML)
        lines = [{"article_id": int(part.split(":")[0]), "quantity": int(part.split(":")[1])} for part in text.split(",")]
        if len(lines) > 30 or len({row["article_id"] for row in lines}) != len(lines) or any(not 1 <= row["quantity"] <= 30 or row["article_id"] < 1 for row in lines):
            return await message.answer("Укажите до 30 разных позиций с количеством от 1 до 30.")
        proposed = data["proposed"]; proposed["lines"] = lines
        await state.update_data(proposed=proposed)
    await state.set_state(ManagerEdit.comment)
    await message.answer("Напишите обязательный комментарий клиенту (до 2000 символов). Не включайте паспортные данные или фотографии.")


@router.message(ManagerEdit.comment)
async def manager_edit_comment(message: Message, state: FSMContext):
    if not await manager_edit_allowed(message, state): return
    comment = (message.text or "").strip()
    if not comment or len(comment) > 2000:
        return await message.answer("Введите комментарий длиной до 2000 символов.")
    data = await state.get_data(); proposal = data["proposed"]
    await state.update_data(comment=comment); await state.set_state(ManagerEdit.confirm)
    lines = ", ".join(f"{row['article_id']} × {row['quantity']}" for row in proposal["lines"])
    text = "Проверьте предложение: " + html.escape(proposal["start"]) + " — " + html.escape(proposal["end"]) + "\nПозиции: " + html.escape(lines) + "\nКлиенту придёт предложение изменений."
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Отправить клиенту", f"sw:editconfirm:{data['booking_id']}")]]))


_assignment_locks = {}


def parse_assignment(text, booking):
    """Parse exactly one selection or exception for each requested unit."""
    assignments, exceptions, selected = {}, [], set()
    expected = {str(row.id): row.quantity for row in booking.lines}
    for part in text.split(";"):
        if part.count(":") != 1: raise ValueError("Формат: строка:ID,нет,неисправен,замена=ID")
        row_text, values = part.split(":", 1)
        if not row_text.strip().isascii() or not row_text.strip().isdigit(): raise ValueError("Неверный номер строки")
        key = str(int(row_text.strip()))
        if key in assignments or key not in expected: raise ValueError("Укажите каждую строку заявки ровно один раз")
        entries = [entry.strip().casefold() for entry in values.split(",")]
        if len(entries) != expected[key]: raise ValueError("Для каждой строки укажите вариант на каждую единицу")
        assignments[key] = []
        for entry in entries:
            if entry in {"нет", "неисправен"}:
                exceptions.append({"line_id": int(key), "reason": "missing" if entry == "нет" else "faulty", "note": ""})
                continue
            replacement = entry.startswith("замена=")
            value = entry.removeprefix("замена=") if replacement else entry
            if not value.isascii() or not value.isdigit() or int(value) < 1: raise ValueError("Укажите ID, нет, неисправен или замена=ID")
            asset_id = int(value)
            if asset_id in selected: raise ValueError("Один экземпляр нельзя назначить дважды")
            selected.add(asset_id); assignments[key].append(asset_id)
            if replacement: exceptions.append({"line_id": int(key), "reason": "replacement", "replacement_id": asset_id, "note": ""})
    if set(assignments) != set(expected): raise ValueError("Укажите все строки заявки")
    if not selected: raise ValueError("Для выдачи нужен хотя бы один экземпляр")
    return assignments, exceptions


def assignment_components(assignments):
    from .rental import list_equipment
    from .inventory import composition_items
    ids = {asset_id for row in assignments.values() for asset_id in row}
    assets = {asset.id: asset for asset in list_equipment() if asset.id in ids}
    if set(assets) != ids: raise ValueError("Один из экземпляров не найден")
    return {str(key): composition_items(asset.article) for key, asset in assets.items()}


async def assignment_confirmation(message, state):
    import secrets
    data = await state.get_data(); nonce = secrets.token_hex(4)
    await state.update_data(assignment_nonce=nonce); await state.set_state(StaffAssignment.confirm)
    rows = data.get("exceptions") or []
    summary = "Автоматически подобрать экземпляры?" if data["assignments"] is None else f"Назначить выбранные экземпляры? Исключений: {len(rows)}."
    await message.answer(summary + " Текущая комплектация будет заменена; доступность проверится повторно.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Подтвердить", f"sw:assignconfirm:{data['booking_id']}:{nonce}")]]))


@router.message(StaffAssignment.choose)
async def staff_assignment_choose(message: Message, state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        await state.clear(); return await message.answer("Комплектация доступна сотруднику в личном чате.")
    text = (message.text or "").strip(); data = await state.get_data()
    booking = await asyncio.to_thread(get_booking, data["booking_id"])
    if not booking or booking.status not in {"confirmed", "preparing"}:
        await state.clear(); return await message.answer("Состояние заявки изменилось. Откройте её заново.")
    if text in {"-", "−"}:
        await state.update_data(assignments=None, exceptions=None)
        return await assignment_confirmation(message, state)
    try:
        assignments, exceptions = parse_assignment(text, booking)
        components = await asyncio.to_thread(assignment_components, assignments)
    except ValueError as exc: return await message.answer(str(exc))
    await state.update_data(assignments=assignments, exceptions=exceptions, assignment_components=components)
    await state.set_state(StaffAssignment.components)
    items = [f"{asset_id} · {html.escape(name)}" for asset_id, names in components.items() for name in names]
    await message.answer("Элементы выбранных экземпляров:\n" + ("\n".join(items) or "Не указаны") + "\n\nДля исключения отправьте: ID | элемент | нет / неисправен / замена | что выдано взамен (только для замены). Повторите для других элементов или отправьте готово.", parse_mode=ParseMode.HTML)


@router.message(StaffAssignment.components)
async def staff_assignment_components(message: Message, state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        await state.clear(); return await message.answer("Комплектация доступна сотруднику в личном чате.")
    text = (message.text or "").strip(); data = await state.get_data()
    if text.casefold() in {"готово", "-", "−"}:
        if not data["exceptions"]: return await assignment_confirmation(message, state)
        await state.set_state(StaffAssignment.note)
        return await message.answer("Комментарий к исключениям (до 2000 символов) или −, чтобы пропустить.")
    parts = [part.strip() for part in text.split("|")]
    if len(parts) not in {3, 4} or not parts[0].isascii() or not parts[0].isdigit():
        return await message.answer("Формат: ID | элемент | нет / неисправен / замена | что выдано взамен")
    asset_id, component, label = str(int(parts[0])), parts[1], parts[2].casefold()
    reason = {"нет":"missing", "неисправен":"faulty", "замена":"replacement"}.get(label)
    replacement = parts[3] if len(parts) == 4 else ""
    if component not in data["assignment_components"].get(asset_id, []) or reason is None or (reason == "replacement" and (not replacement or len(replacement) > 200)):
        return await message.answer("Проверьте ID, название элемента и причину; для замены укажите, что выдано взамен.")
    exceptions = data["exceptions"]
    if any(str(row.get("equipment_id")) == asset_id and row.get("component") == component for row in exceptions):
        return await message.answer("Этот элемент уже указан. Для изменения отмените и начните комплектацию заново.")
    line_id = next(int(key) for key, values in data["assignments"].items() if int(asset_id) in values)
    exceptions.append({"line_id":line_id, "equipment_id":int(asset_id), "component":component, "reason":reason, "replacement_name":replacement, "note":""})
    await state.update_data(exceptions=exceptions)
    await message.answer("Исключение добавлено. Укажите следующее или отправьте готово.")


@router.message(StaffAssignment.note)
async def staff_assignment_note(message: Message, state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        await state.clear(); return await message.answer("Комплектация доступна сотруднику в личном чате.")
    note = (message.text or "").strip()
    if len(note) > 2000: return await message.answer("Комментарий должен быть не длиннее 2000 символов.")
    data = await state.get_data()
    for row in data["exceptions"]: row["note"] = "" if note in {"-", "−"} else note
    await state.update_data(exceptions=data["exceptions"])
    await assignment_confirmation(message, state)


_inspection_locks = {}


def inspection_context(booking_id, equipment_id):
    from .db import Session, BookingAsset
    from .handover import asset_components, composition_signature
    with Session() as session:
        assigned = session.get(BookingAsset, (booking_id, equipment_id))
        if not assigned or assigned.deleted_at is not None:
            raise ValueError("Экземпляр больше не назначен заявке")
        components = asset_components(session, booking_id, equipment_id)
        return components, composition_signature(components)


async def inspection_list(message, booking_id, user_id, page=0):
    if not await asyncio.to_thread(staff_allows, user_id, "operator"):
        raise PermissionError("Доступ только для сотрудников")
    booking = await asyncio.to_thread(get_booking, booking_id)
    if not booking or booking.status not in {"preparing", "return_inspection"}:
        raise Conflict("Проверка недоступна на текущем этапе")
    stage = "pre_issue" if booking.status == "preparing" else "check_in"
    page = max(0, min(page, max(0, (len(booking.assets) - 1) // PAGE_SIZE)))
    rows = []
    for asset in booking.assets[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]:
        saved = next((item for item in booking.inspections if item.equipment_id == asset.equipment_id and item.stage == stage), None)
        label = f"{asset.equipment.name} · {asset.equipment.inventory_number} · " + ("исправно" if saved and saved.result == "pass" else "неисправность" if saved else "не проверено")
        rows.append([button(label[:60], f"sw:inspection:{booking_id}:{asset.equipment_id}")])
    navigation = []
    if page: navigation.append(button("← Назад", f"sw:inspect:{booking_id}:{page-1}"))
    if (page + 1) * PAGE_SIZE < len(booking.assets): navigation.append(button("Далее →", f"sw:inspect:{booking_id}:{page+1}"))
    if navigation: rows.append(navigation)
    rows.append([button("К заявке", f"sw:open:{booking_id}")])
    await message.answer(("Проверка перед выдачей" if stage == "pre_issue" else "Проверка при возврате") + f" · страница {page+1}", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def start_inspection(query, state, booking_id, equipment_id):
    import secrets
    booking = await asyncio.to_thread(get_booking, booking_id)
    if not booking or booking.status not in {"preparing", "return_inspection"}:
        raise Conflict("Проверка недоступна на текущем этапе")
    asset = next((item for item in booking.assets if item.equipment_id == equipment_id), None)
    if not asset: raise ValueError("Экземпляр не назначен заявке")
    components, signature = await asyncio.to_thread(inspection_context, booking_id, equipment_id)
    stage = "pre_issue" if booking.status == "preparing" else "check_in"
    nonce = secrets.token_hex(4)
    await state.clear(); await state.update_data(booking_id=booking_id, equipment_id=equipment_id, stage=stage, signature=signature, components=components, nonce=nonce)
    await state.set_state(StaffInspection.choose)
    component_text = "\n".join("• " + html.escape(str(item.get("replacement_name") or item.get("name") or "Элемент")) + (" · не выдано" if item.get("state") in {"missing", "faulty"} else "") for item in components)
    text = f"<b>{html.escape(asset.equipment.name)}</b> · {html.escape(asset.equipment.inventory_number)}\n" + (component_text or "Комплектация не указана.")
    rows = [[button("Всё проверено и исправно", f"sw:inspectionpass:{booking_id}:{equipment_id}:{nonce}")],
            [button("Зафиксировать неисправность", f"sw:inspectionfail:{booking_id}:{equipment_id}:{nonce}")],
            [button("К списку проверок", f"sw:inspect:{booking_id}")]]
    await query.answer()
    await query.message.answer(text + "\nПроверьте каждый выданный элемент перед подтверждением.", parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def inspection_action(query, state, parts):
    if len(parts) not in (5, 6): raise ValueError("Действие недоступно")
    action, booking_id, equipment_id, nonce = parts[1], int(parts[2]), int(parts[3]), parts[4]
    lock = _inspection_locks.setdefault(query.from_user.id, asyncio.Lock())
    async with lock:
        data = await state.get_data(); current = await state.get_state()
        if data.get("booking_id") != booking_id or data.get("equipment_id") != equipment_id or data.get("nonce") != nonce:
            raise Conflict("Проверка устарела. Откройте её заново")
        if action == "inspectionfail" and current == StaffInspection.choose.state:
            await state.set_state(StaffInspection.defect); await query.answer()
            return await query.message.answer("Опишите неисправность (до 4000 символов). Отмена: /cancel_booking.")
        if action == "inspectioncharge" and current == StaffInspection.charge.state and len(parts) == 6 and parts[5] in {"yes", "no"}:
            await state.update_data(charge_customer=parts[5] == "yes"); await state.set_state(StaffInspection.confirm)
            await query.answer()
            return await query.message.answer("Сохранить неисправность? Экземпляр будет отправлен в ремонт.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Сохранить", f"sw:inspectionsave:{booking_id}:{equipment_id}:{nonce}")]]))
        if action == "inspectionpass" and current == StaffInspection.choose.state:
            result, checklist = "pass", {f"component:{index}": True for index, item in enumerate(data["components"]) if item.get("state") not in {"missing", "faulty"}}
        elif action == "inspectionsave" and current == StaffInspection.confirm.state:
            result, checklist = "fail", {}
        else: raise Conflict("Действие устарело. Откройте проверку заново")
        from .rental import record_inspection
        actor = (getattr(query.from_user, "full_name", "") or "").strip() or f"оператор {query.from_user.id}"
        await asyncio.to_thread(record_inspection, booking_id, equipment_id, data["stage"], result, checklist, data.get("notes", ""), query.from_user.id, data.get("defect", ""), data.get("cost", "0"), data.get("charge_customer", False), actor, data["signature"])
        wants_photo = result == "fail" and data["stage"] == "check_in"
        if wants_photo:
            await state.set_state(StaffInspection.photo)
        else:
            await state.clear()
        await query.answer("Результат проверки сохранён")
        if wants_photo:
            return await query.message.answer("Пришлите фото повреждения (JPEG, PNG или WebP, до 8 МБ) или отправьте −, чтобы пропустить. Не присылайте документы и персональные данные.")
        return await inspection_list(query.message, booking_id, query.from_user.id)


async def inspection_text_allowed(message, state):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        await state.clear(); await message.answer("Проверка доступна сотруднику в личном чате.")
        return False
    return True


@router.message(StaffInspection.defect)
async def inspection_defect(message: Message, state: FSMContext):
    if not await inspection_text_allowed(message, state): return
    value = (message.text or "").strip()
    if not value or len(value) > 4000: return await message.answer("Опишите неисправность текстом до 4000 символов.")
    await state.update_data(defect=value); await state.set_state(StaffInspection.notes)
    await message.answer("Введите дополнительный комментарий до 2000 символов или −, чтобы пропустить.")


@router.message(StaffInspection.notes)
async def inspection_notes(message: Message, state: FSMContext):
    if not await inspection_text_allowed(message, state): return
    value = (message.text or "").strip()
    if len(value) > 2000: return await message.answer("Комментарий должен быть не длиннее 2000 символов.")
    await state.update_data(notes="" if value in {"-", "−"} else value); await state.set_state(StaffInspection.cost)
    await message.answer("Укажите оценку ущерба в рублях, например 1200.50, или 0.")


@router.message(StaffInspection.cost)
async def inspection_cost(message: Message, state: FSMContext):
    if not await inspection_text_allowed(message, state): return
    try:
        value = Decimal((message.text or "").strip().replace(",", "."))
        if not value.is_finite() or value < 0 or value >= Decimal("10000000000") or value.as_tuple().exponent < -2: raise InvalidOperation
    except InvalidOperation:
        return await message.answer("Введите неотрицательную сумму с точностью до копеек.")
    data = await state.get_data(); await state.update_data(cost=str(value)); await state.set_state(StaffInspection.charge)
    base = f"sw:inspectioncharge:{data['booking_id']}:{data['equipment_id']}:{data['nonce']}"
    await message.answer("Отнести ущерб на клиента?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Да", base + ":yes"), button("Нет", base + ":no")]]))


class LimitedPhotoBuffer:
    """A file-like sink that rejects oversized Telegram downloads while streaming."""
    def __init__(self, maximum):
        from io import BytesIO
        self.buffer = BytesIO()
        self.maximum = maximum

    def write(self, chunk):
        if self.buffer.tell() + len(chunk) > self.maximum:
            raise ValueError(f"Файл превышает {self.maximum // (1024 * 1024)} МБ")
        return self.buffer.write(chunk)

    def flush(self):
        self.buffer.flush()

    def getvalue(self):
        return self.buffer.getvalue()


@router.message(StaffInspection.photo)
async def inspection_photo(message: Message, state: FSMContext, bot):
    if not await inspection_text_allowed(message, state): return
    from aiogram.exceptions import TelegramAPIError
    from aiohttp import ClientError
    from fastapi import HTTPException
    lock = _inspection_locks.setdefault(message.from_user.id, asyncio.Lock())
    async with lock:
        if await state.get_state() != StaffInspection.photo.state:
            return await message.answer("Проверка уже завершена. Откройте её снова, чтобы заменить фото.")
        data = await state.get_data()
        if (message.text or "").strip() in {"-", "−"}:
            await state.clear()
            return await inspection_list(message, data["booking_id"], message.from_user.id)
        if message.photo:
            attachment, content_type = message.photo[-1], "image/jpeg"
        elif message.document and message.document.mime_type in {"image/jpeg", "image/png", "image/webp"}:
            attachment, content_type = message.document, message.document.mime_type
        else:
            return await message.answer("Пришлите фото JPEG, PNG или WebP либо −, чтобы пропустить.")
        maximum = 8 * 1024 * 1024
        if attachment.file_size and attachment.file_size > maximum:
            return await message.answer("Фото превышает 8 МБ. Выберите файл меньшего размера.")
        buffer = LimitedPhotoBuffer(maximum)
        try:
            await bot.download(attachment, destination=buffer, seek=False)
            from .miniapp import save_inspection_photo_bytes
            user = {"id": message.from_user.id, "first_name": message.from_user.first_name or "", "last_name": message.from_user.last_name or "", "username": message.from_user.username or ""}
            await save_inspection_photo_bytes(data["booking_id"], data["equipment_id"], buffer.getvalue(), content_type, user)
        except (ValueError, HTTPException) as exc:
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            return await message.answer(f"Не удалось сохранить фото: {detail}. Повторите или отправьте −.")
        except (TelegramAPIError, ClientError, OSError, TimeoutError):
            return await message.answer("Не удалось загрузить фото. Проверьте соединение и повторите или отправьте −.")
        await state.clear()
        await message.answer("Фото повреждения сохранено.")
        await inspection_list(message, data["booking_id"], message.from_user.id)


_repair_queries = {}
_quiet_locks = {}


@router.message(Command("repairs"))
async def repairs_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        return await message.answer("Раздел доступен сотруднику в личном чате.")
    query = (message.text or "").partition(" ")[2].strip()[:100]
    _repair_queries[message.from_user.id] = query
    await repair_list(message, message.from_user.id, 0)


async def repair_list(message, user_id, page=0):
    from .rental import list_repairs
    if not await asyncio.to_thread(staff_allows, user_id, "operator"):
        raise PermissionError("Доступ только для сотрудников")
    query = _repair_queries.get(user_id, "").casefold()
    tickets = await asyncio.to_thread(list_repairs)
    tickets = [ticket for ticket in tickets if query in f"{ticket.id} {ticket.equipment.name} {ticket.equipment.inventory_number} {ticket.status}".casefold()]
    page = max(0, min(page, max(0, (len(tickets)-1)//PAGE_SIZE)))
    rows = [[button(f"№{ticket.id} · {ticket.equipment.name} · {'закрыт' if ticket.status == 'closed' else 'в ремонте'}"[:60], f"rp:open:{ticket.id}")] for ticket in tickets[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"rp:page:{page-1}"))
    if (page+1)*PAGE_SIZE < len(tickets): nav.append(button("Далее →", f"rp:page:{page+1}"))
    if nav: rows.append(nav)
    if not rows: return await message.answer("Ремонтов по этому запросу нет. Для поиска: /repairs НАЗВАНИЕ или НОМЕР.")
    await message.answer(f"Ремонты · страница {page+1}. Поиск: /repairs НАЗВАНИЕ или НОМЕР.", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def repair_detail(message, user_id, ticket_id):
    from .rental import list_repairs
    if not await asyncio.to_thread(staff_allows, user_id, "operator"):
        raise PermissionError("Доступ только для сотрудников")
    ticket = next((item for item in await asyncio.to_thread(list_repairs) if item.id == ticket_id), None)
    if not ticket: raise ValueError("Ремонт не найден")
    description = html.escape((ticket.defect or "Не указано")[:1000])
    text = f"<b>Ремонт №{ticket.id}</b>\n{html.escape(ticket.equipment.name)} · № {html.escape(ticket.equipment.inventory_number)}\nСтатус: {'закрыт' if ticket.status == 'closed' else 'в ремонте'}\nНеисправность: {description}\nОценка: {html.escape(str(ticket.estimated_cost))} ₽\nУщерб клиента: {'да' if ticket.charge_customer else 'нет'}"
    rows = []
    if ticket.status != "closed": rows.append([button("Закрыть ремонт", f"rp:ask:{ticket.id}")])
    rows.append([button("К списку", "rp:page:0")])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith("rp:"))
async def repair_action(query: CallbackQuery):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников в личном чате", show_alert=True)
    try:
        parts = query.data.split(":")
        if len(parts) != 3: raise ValueError("Действие недоступно")
        action, identifier = parts[1], int(parts[2])
        if action == "page":
            await query.answer(); return await repair_list(query.message, query.from_user.id, identifier)
        if action == "open":
            await query.answer(); return await repair_detail(query.message, query.from_user.id, identifier)
        if action == "ask":
            await query.answer()
            return await query.message.answer("Закрыть ремонт? Состояние экземпляра будет пересчитано.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Закрыть ремонт", f"rp:close:{identifier}"),button("Назад", f"rp:open:{identifier}")]]))
        if action == "close":
            from .rental import close_repair
            await asyncio.to_thread(close_repair, identifier, query.from_user.id)
            await query.answer("Ремонт закрыт")
            return await repair_detail(query.message, query.from_user.id, identifier)
        raise ValueError("Действие недоступно")
    except (ValueError, Conflict, PermissionError) as exc:
        await query.answer(str(exc)[:180], show_alert=True)


@router.message(Command("quiet"))
async def quiet_command(message: Message, state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        return await message.answer("Настройки доступны сотруднику в личном чате.")
    from .operator_preferences import preferences
    settings = await asyncio.to_thread(preferences, message.from_user.id)
    await state.clear(); await state.set_state(QuietHours.input)
    current = f"{settings['quiet_start']}–{settings['quiet_end']} МСК" if settings['quiet_start'] else "выключены"
    await message.answer(f"Тихие часы: {current}. Введите начало и конец через пробел, например 23:00 08:00, или − для отключения. Отмена: /cancel_booking.")


@router.message(QuietHours.input)
async def quiet_input(message: Message, state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        await state.clear(); return await message.answer("Настройки доступны сотруднику в личном чате.")
    value = (message.text or "").strip()
    if value in {"-", "−"}: start, end = None, None
    else:
        match = re.fullmatch(r"([0-2]\d:[0-5]\d)\s+([0-2]\d:[0-5]\d)", value)
        if not match: return await message.answer("Укажите время в формате ЧЧ:ММ ЧЧ:ММ или −.")
        start, end = match.groups()
        if int(start[:2]) > 23 or int(end[:2]) > 23 or start == end:
            return await message.answer("Укажите два разных времени от 00:00 до 23:59.")
    import secrets
    nonce = secrets.token_hex(4)
    await state.update_data(quiet_start=start, quiet_end=end, quiet_nonce=nonce); await state.set_state(QuietHours.confirm)
    label = f"{start}–{end} МСК" if start else "выключить тихие часы"
    await message.answer(f"Сохранить: {label}?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Сохранить", f"qh:save:{nonce}")]]))


@router.callback_query(F.data.startswith("qh:"))
async def quiet_action(query: CallbackQuery, state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников", show_alert=True)
    parts = query.data.split(":")
    if len(parts) != 3 or parts[1] != "save": return await query.answer("Действие недоступно", show_alert=True)
    async with _quiet_locks.setdefault(query.from_user.id, asyncio.Lock()):
        data = await state.get_data()
        if await state.get_state() != QuietHours.confirm.state or parts[2] != data.get("quiet_nonce"):
            return await query.answer("Настройка устарела. Откройте /quiet заново", show_alert=True)
        if not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
            return await query.answer("Доступ только для сотрудников", show_alert=True)
        from .operator_preferences import save_preferences
        try:
            await asyncio.to_thread(save_preferences, query.from_user.id, data.get("quiet_start"), data.get("quiet_end"))
        except ValueError as exc:
            return await query.answer(str(exc)[:180], show_alert=True)
        await state.clear(); await query.answer("Тихие часы сохранены")
        await query.message.answer("Настройка сохранена.")


_support_queries = {}


def support_app_button(thread_id):
    base = os.getenv("PUBLIC_URL", "").rstrip("/")
    if not base.startswith("https://"): return None
    return InlineKeyboardButton(text="Открыть защищённое обращение", web_app=WebAppInfo(url=f"{base}/miniapp?startapp=support_{thread_id}"))


@router.message(Command("my_support"))
async def customer_support_command(message: Message):
    if not private(message): return await message.answer("Откройте личный чат с ботом.")
    await customer_support_list(message, message.from_user.id, 0)


async def customer_support_list(message, user_id, page):
    from .support import list_threads
    entries = await asyncio.to_thread(list_threads, customer_id=user_id)
    page = max(0, min(page, max(0, (len(entries)-1)//PAGE_SIZE)))
    lines = [f"№{row['id']}" + (f" · {html.escape(row['request_number'])}" if row['request_number'] else "") + f" · {html.escape(row['customer_state'])}" for row in entries[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"sc:page:{page-1}"))
    if (page+1)*PAGE_SIZE < len(entries): nav.append(button("Далее →", f"sc:page:{page+1}"))
    await message.answer("Ваши обращения:\n" + ("\n".join(lines) or "Нет обращений"), parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=[nav]) if nav else None)


@router.callback_query(F.data.startswith("sc:page:"))
async def customer_support_page(query: CallbackQuery):
    if not private(query): return await query.answer("Откройте личный чат с ботом", show_alert=True)
    try:
        page = int(query.data.rsplit(":",1)[1]); await query.answer()
        await customer_support_list(query.message, query.from_user.id, page)
    except ValueError: await query.answer("Страница недоступна", show_alert=True)


@router.message(Command("support"))
async def staff_support_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, "operator"):
        return await message.answer("Раздел доступен сотруднику в личном чате.")
    _support_queries[message.from_user.id] = (message.text or "").partition(" ")[2].strip()[:100]
    await staff_support_list(message, message.from_user.id, 0)


async def staff_support_list(message, user_id, page):
    from .support import list_threads
    if not await asyncio.to_thread(staff_allows, user_id, "operator"): raise PermissionError("Доступ только для сотрудников")
    search = _support_queries.get(user_id, "").casefold()
    entries = await asyncio.to_thread(list_threads)
    entries = [row for row in entries if search in f"{row['id']} {row['request_number']} {row['status']}".casefold()]
    page = max(0, min(page, max(0, (len(entries)-1)//PAGE_SIZE)))
    rows = [[button(f"№{row['id']} · {row['request_number'] or 'общее'} · {row['status']}", f"sp:open:{row['id']}")] for row in entries[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"sp:page:{page-1}"))
    if (page+1)*PAGE_SIZE < len(entries): nav.append(button("Далее →", f"sp:page:{page+1}"))
    if nav: rows.append(nav)
    if not rows: return await message.answer("Обращений не найдено. Поиск: /support НОМЕР.")
    await message.answer(f"Обращения · страница {page+1}. Поиск: /support НОМЕР.", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def support_detail(message, actor_id, thread_id):
    from .support import list_threads
    from .roles import configured_ids
    if not await asyncio.to_thread(staff_allows, actor_id, "operator"): raise PermissionError("Доступ только для сотрудников")
    row = next((entry for entry in await asyncio.to_thread(list_threads) if entry["id"] == thread_id), None)
    if not row: raise ValueError("Обращение не найдено")
    pii = actor_id in configured_ids("PII_ADMIN_IDS")
    owner = row["owner_id"]
    text = f"<b>Обращение №{thread_id}</b>\nЗаявка: {html.escape(row['request_number'] or 'общее')}\nСтатус: {html.escape(row['status'])}\nОтветственный: {owner or 'не назначен'}"
    rows = []
    if row["status"] != "resolved":
        if owner is None and pii: rows.append([button("Взять в работу", f"sp:claim:{thread_id}")])
        if owner == actor_id and pii: rows.append([button("Закрыть обращение", f"sp:askclose:{thread_id}")])
        rows.append([button("Передать сотруднику", f"sp:owners:{thread_id}")])
    if pii:
        link = support_app_button(thread_id)
        if link: rows.append([link])
        if owner == actor_id and row["status"] != "resolved": text += "\nОтвет: /reply НОМЕР_ОБРАЩЕНИЯ ТЕКСТ. Не передавайте паспортные данные в чат."
    rows.append([button("К обращениям", "sp:page:0")])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith("sp:"))
async def staff_support_action(query: CallbackQuery):
    from .support import SupportConflict
    from .roles import configured_ids
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников", show_alert=True)
    parts = query.data.split(":")
    try:
        if len(parts) < 3: raise ValueError("Действие недоступно")
        action, identifier, actor = parts[1], int(parts[2]), query.from_user.id
        if action == "page" and len(parts) == 3:
            await query.answer(); return await staff_support_list(query.message, actor, identifier)
        if action == "open" and len(parts) == 3:
            await query.answer(); return await support_detail(query.message, actor, identifier)
        if action in {"claim", "askclose", "close"} and actor not in configured_ids("PII_ADMIN_IDS"):
            raise PermissionError("Для работы с обращением нужен доступ к персональным данным")
        if action == "claim" and len(parts) == 3:
            from .support import claim_thread
            await asyncio.to_thread(claim_thread, identifier, actor)
            await query.answer("Обращение принято в работу")
            return await support_detail(query.message, actor, identifier)
        if action == "askclose" and len(parts) == 3:
            await query.answer(); return await query.message.answer("Закрыть обращение?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Закрыть", f"sp:close:{identifier}"),button("Назад",f"sp:open:{identifier}")]]))
        if action == "close" and len(parts) == 3:
            from .support import resolve_thread
            await asyncio.to_thread(resolve_thread, identifier, actor)
            await query.answer("Обращение закрыто")
            return await support_detail(query.message, actor, identifier)
        if action == "owners" and len(parts) == 3:
            candidates = [uid for uid in sorted(configured_ids("PII_ADMIN_IDS")) if await asyncio.to_thread(staff_allows, uid, "operator")]
            rows = [[button(f"Сотрудник {uid}", f"sp:owner:{identifier}:{uid}")] for uid in candidates[:90]]
            if not rows: raise ValueError("Нет сотрудников с доступом к персональным данным")
            await query.answer(); return await query.message.answer("Кому передать обращение?", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        if action == "owner" and len(parts) == 4:
            from .support import reassign_thread
            from .miniapp import notify_support_owner
            new_owner = int(parts[3]); await asyncio.to_thread(reassign_thread, identifier, actor, new_owner)
            await query.answer("Обращение передано")
            await notify_support_owner(new_owner, identifier, "")
            return await support_detail(query.message, actor, identifier)
        raise ValueError("Действие недоступно")
    except (ValueError, PermissionError, Conflict, SupportConflict) as exc:
        await query.answer(str(exc)[:180], show_alert=True)


_customer_locks = {}


def receipt_pages(data, max_chars=2800):
    """List the full non-identity handover summary in bounded, readable pages."""
    lines = ["Состав выдачи:"]
    for item in data.get("snapshot", []):
        name = str(item.get("name") or "Оборудование")
        lines.append("• " + name)
        for feature in item.get("features", []):
            lines.append("  Особенность: " + str(feature.get("description") or ""))
        for component in item.get("components", []):
            label = str(component.get("replacement_name") or component.get("name") or "Элемент")
            state = " · не выдано" if component.get("state") in {"missing", "faulty"} else ""
            lines.append("  Комплект: " + label + state)
    exceptions = data.get("exceptions", [])
    if exceptions:
        lines.append("Изменения и исключения:")
        labels = {"missing":"отсутствует", "faulty":"неисправность", "replacement":"замена"}
        for item in exceptions:
            line = "• " + str(item.get("name") or "Оборудование")
            if item.get("component"): line += " / " + str(item["component"])
            line += ": " + labels.get(item.get("reason"), "изменено")
            if item.get("replacement_name"): line += " → " + str(item["replacement_name"])
            lines.append(line)
        if any(item.get("note") for item in exceptions):
            lines.append("Примечания к исключениям доступны только в защищённой заявке. Прочитайте их перед подтверждением.")
    pages, page = [], ""
    for line in lines:
        while line:
            room = max_chars - len(page) - (1 if page else 0)
            if room <= 0:
                pages.append(page); page = ""; continue
            chunk, line = line[:room], line[room:]
            page += ("\n" if page else "") + chunk
            if line: pages.append(page); page = ""
    if page: pages.append(page)
    return pages or ["Перечень недоступен"]


async def begin_customer_receipt(query,state,booking_id):
    from .handover import handover_summary_signature
    booking=await owned_booking(booking_id,query.from_user.id)
    data=await asyncio.to_thread(handover_state,booking_id)
    if booking.status!='ready' or data.get('recipient_id')!=query.from_user.id or not data.get('snapshot'):
        raise Conflict("Перечень выдачи пока недоступен")
    nonce=secrets.token_hex(4); pages=receipt_pages(data)
    await state.clear();await state.update_data(receipt_booking=booking_id,receipt_nonce=nonce,receipt_pages=pages,receipt_seen=0,receipt_signature=handover_summary_signature(data),receipt_partial=bool(data.get('exceptions')))
    await state.set_state(CustomerAttestation.reading);await query.answer()
    await send_customer_receipt_page(query.message,booking_id,nonce,pages,0,0)


async def send_customer_receipt_page(message,booking_id,nonce,pages,page,seen):
    rows=[]
    nav=[]
    if page>0: nav.append(button("← Назад",f"cw:receiptpage:{booking_id}:{nonce}:{page-1}"))
    if page+1<len(pages): nav.append(button("Далее →",f"cw:receiptpage:{booking_id}:{nonce}:{page+1}"))
    if nav: rows.append(nav)
    if page==len(pages)-1 and seen==len(pages)-1:
        rows.append([button("Ознакомлен, получил",f"cw:receiptconfirm:{booking_id}:{nonce}")])
    link=app_button("Открыть защищённую заявку",booking_id)
    if link: rows.append([link])
    rows.append([button("Назад к заявке",f"cw:open:{booking_id}")])
    await message.answer(f"Перечень выдачи · {page+1}/{len(pages)}\n\n{pages[page]}",reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def customer_receipt_page(query,state,booking_id,nonce,page):
    data=await state.get_data()
    if await state.get_state()!=CustomerAttestation.reading.state or data.get('receipt_booking')!=booking_id or data.get('receipt_nonce')!=nonce:
        raise Conflict("Перечень устарел. Откройте его заново")
    pages=data['receipt_pages'];seen=data['receipt_seen']
    if page<0 or page>=len(pages) or page>seen+1: raise ValueError("Страница недоступна")
    seen=max(seen,page);await state.update_data(receipt_seen=seen);await query.answer()
    await send_customer_receipt_page(query.message,booking_id,nonce,pages,page,seen)


async def customer_receipt_confirm(query,state,booking_id,nonce):
    async with _customer_locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=CustomerAttestation.reading.state or data.get('receipt_booking')!=booking_id or data.get('receipt_nonce')!=nonce or data.get('receipt_seen',-1)!=len(data.get('receipt_pages',[]))-1:
            raise Conflict("Сначала ознакомьтесь со всеми страницами перечня")
        await asyncio.to_thread(customer_attest,booking_id,query.from_user.id,'received',data['receipt_partial'],data['receipt_signature'])
        await state.clear();await query.answer("Получение подтверждено")
        return await show_customer_booking(query.message,booking_id,query.from_user.id)


@router.message(CustomerDispute.comment)
async def customer_dispute_comment(message: Message,state: FSMContext):
    if not private(message): await state.clear();return await message.answer("Откройте личный чат с ботом.")
    comment=(message.text or '').strip()
    if not comment or len(comment)>2000: return await message.answer("Введите причину длиной до 2000 символов.")
    nonce=secrets.token_hex(4);data=await state.get_data()
    await state.update_data(dispute_comment=comment,dispute_nonce=nonce);await state.set_state(CustomerDispute.confirm)
    await message.answer("Отправить оспаривание менеджеру?",reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Отправить",f"cw:disputesave:{data['dispute_booking']}:{nonce}")]]))


async def customer_dispute_confirm(query,state,booking_id,nonce):
    async with _customer_locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=CustomerDispute.confirm.state or data.get('dispute_booking')!=booking_id or data.get('dispute_nonce')!=nonce:
            raise Conflict("Ответ устарел. Откройте предложение заново")
        from .booking_changes import update_request
        await asyncio.to_thread(update_request,booking_id,query.from_user.id,None,None,None,data['dispute_change'],False,data['dispute_comment'])
        await state.clear();await query.answer("Оспаривание отправлено")
        return await show_customer_booking(query.message,booking_id,query.from_user.id)


async def begin_customer_edit(query,state,booking,change_id):
    if change_id is None:
        if booking.status != 'pending': raise Conflict('Изменение доступно для ожидающей заявки')
    else:
        from .booking_changes import change_view
        change=await asyncio.to_thread(change_view,booking.id,query.from_user.id)
        if booking.status!='needs_changes' or not change or change['id']!=change_id or change['status']!='pending' or change['change_type']!='client_fix':
            raise Conflict('Запрос исправления изменился. Откройте заявку заново')
    before={'start':booking.starts_at.isoformat(),'end':booking.ends_at.isoformat(),'lines':sorted([{'article_id':row.article_id,'quantity':row.quantity,'name':row.article.name} for row in booking.lines],key=lambda row:row['article_id'])}
    await state.clear();await state.update_data(customer_edit_booking=booking.id,customer_edit_change=change_id,customer_edit_before=before)
    await state.set_state(CustomerEdit.dates);await query.answer()
    await query.message.answer('Введите даты по Москве: ДД.ММ.ГГГГ ЧЧ:ММ | ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы оставить текущие сроки, отправьте −. Отмена: /cancel_booking.')


@router.message(CustomerEdit.dates)
async def customer_edit_dates(message: Message,state: FSMContext):
    if not private(message): await state.clear();return await message.answer('Откройте личный чат с ботом.')
    data=await state.get_data()
    try:
        await owned_booking(data['customer_edit_booking'],message.from_user.id)
        value=(message.text or '').strip()
        if value in {'-','−'}:
            start=datetime.fromisoformat(data['customer_edit_before']['start']);end=datetime.fromisoformat(data['customer_edit_before']['end'])
        else:
            first,last=value.split('|')
            start=datetime.strptime(first.strip(),'%d.%m.%Y %H:%M').replace(tzinfo=MOSCOW)
            end=datetime.strptime(last.strip(),'%d.%m.%Y %H:%M').replace(tzinfo=MOSCOW)
        from .rental import availability,validate_interval
        await asyncio.to_thread(validate_interval,start,end,enforce_booking_notice=True)
        items=await asyncio.to_thread(availability,start,end)
    except (ValueError,Conflict) as exc:
        return await message.answer(f'Не удалось проверить сроки: {exc}. Введите две даты через | или −.')
    lines=[{'article_id':row['article_id'],'quantity':row['quantity']} for row in data['customer_edit_before']['lines']]
    await state.update_data(customer_edit_proposed={'start':start.isoformat(),'end':end.isoformat(),'lines':lines});await state.set_state(CustomerEdit.lines)
    examples='\n'.join(f"{item['id']} · {html.escape(item.get('title') or item['name'])} · доступно {item['available_quantity']}" for item in items[:20])
    await message.answer('Укажите полный состав как ID:количество, например 12:2, 18:1. Чтобы оставить состав, отправьте −. Для поиска отправьте название. Доступность будет проверена при сохранении.\n\n'+(examples or 'Каталог пуст.'),parse_mode=ParseMode.HTML)


@router.message(CustomerEdit.lines)
async def customer_edit_lines(message: Message,state: FSMContext):
    if not private(message): await state.clear();return await message.answer('Откройте личный чат с ботом.')
    data=await state.get_data(); text=(message.text or '').strip()
    try: await owned_booking(data['customer_edit_booking'],message.from_user.id)
    except ValueError:
        await state.clear();return await message.answer('Заявка недоступна.')
    if text not in {'-','−'}:
        if not re.fullmatch(r'\s*\d+\s*:\s*\d+(\s*,\s*\d+\s*:\s*\d+)*\s*',text):
            from .rental import availability
            proposed=data['customer_edit_proposed']
            try: items=await asyncio.to_thread(availability,datetime.fromisoformat(proposed['start']),datetime.fromisoformat(proposed['end']))
            except ValueError as exc: return await message.answer(f'Не удалось загрузить каталог: {exc}')
            found=[item for item in items if text and text.casefold() in ' '.join(str(item.get(key) or '') for key in ('title','name','sku','brand')).casefold()]
            lines='\n'.join(f"{item['id']} · {html.escape(item.get('title') or item['name'])} · доступно {item['available_quantity']}" for item in found[:20])
            return await message.answer(lines or 'Ничего не найдено. Введите другое название или состав как ID:количество.',parse_mode=ParseMode.HTML)
        selected=[{'article_id':int(part.split(':')[0]),'quantity':int(part.split(':')[1])} for part in text.split(',')]
        if len(selected)>30 or len({row['article_id'] for row in selected})!=len(selected) or any(row['article_id']<1 or not 1<=row['quantity']<=30 for row in selected):
            return await message.answer('Укажите до 30 разных позиций с количеством от 1 до 30.')
        proposed=data['customer_edit_proposed'];proposed['lines']=selected;await state.update_data(customer_edit_proposed=proposed)
    data=await state.get_data();proposed=data['customer_edit_proposed'];nonce=secrets.token_hex(4)
    await state.update_data(customer_edit_nonce=nonce);await state.set_state(CustomerEdit.confirm)
    selection=', '.join(f"{row['article_id']} × {row['quantity']}" for row in proposed['lines'])
    await message.answer('Проверьте сроки и состав перед сохранением:\n'+html.escape(proposed['start'])+' — '+html.escape(proposed['end'])+'\nПозиции: '+html.escape(selection),parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Сохранить',f"cw:editsave:{data['customer_edit_booking']}:{nonce}")]]))


async def customer_edit_save(query,state,booking_id,nonce):
    async with _customer_locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=CustomerEdit.confirm.state or data.get('customer_edit_booking')!=booking_id or data.get('customer_edit_nonce')!=nonce:
            raise Conflict('Изменение устарело. Откройте заявку заново')
        from .booking_changes import update_request
        proposed=data['customer_edit_proposed']
        await asyncio.to_thread(update_request,booking_id,query.from_user.id,datetime.fromisoformat(proposed['start']),datetime.fromisoformat(proposed['end']),proposed['lines'],data.get('customer_edit_change'),True,'',data['customer_edit_before'])
        await state.clear();await query.answer('Заявка изменена')
        return await show_customer_booking(query.message,booking_id,query.from_user.id)


_staff_workflow_locks = {}


def staff_assignees():
    from sqlalchemy import select
    from .db import Session, StaffRole, TrustedSigner
    from .roles import configured_ids
    with Session() as session:
        rows=session.scalars(select(StaffRole).where(StaffRole.telegram_id.in_(configured_ids('ADMIN_IDS')))).all()
        result=[]
        for row in rows:
            if row.role not in {'operator','manager','admin'}: continue
            signer=session.get(TrustedSigner,row.telegram_id)
            result.append({'id':row.telegram_id,'name':signer.full_name if signer and signer.full_name else str(row.telegram_id)})
        return sorted(result,key=lambda item:item['id'])


def workflow_snapshot(booking):
    return {'start':booking.starts_at.isoformat(),'end':booking.ends_at.isoformat(),'lines':sorted([{'article_id':row.article_id,'quantity':row.quantity,'name':row.article.name} for row in booking.lines],key=lambda row:row['article_id'])}


async def staff_choices(message,actor,booking_id,page,kind):
    booking=await asyncio.to_thread(get_booking,booking_id)
    if not booking: raise ValueError('Заявка не найдена')
    if kind=='assignees':
        if not await asyncio.to_thread(staff_allows,actor,'manager'): raise PermissionError('Нужна роль менеджера')
        choices=await asyncio.to_thread(staff_assignees)
        label=lambda item:item['name'];callback=lambda item:f"wf:assignee:{booking_id}:{item['id']}"
        title='Кому передать заявку?'
    else:
        if booking.status!='return_inspection': raise Conflict('Результат доступен при проверке возврата')
        choices=booking.assets
        label=lambda item:f"{item.equipment.name} · {item.equipment.inventory_number}"
        callback=lambda item:f"wf:finding:{booking_id}:{item.equipment_id}"
        title='Выберите экземпляр для фиксации результата:'
    page=max(0,min(page,max(0,(len(choices)-1)//PAGE_SIZE)))
    rows=[[button(label(item)[:60],callback(item))] for item in choices[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page:nav.append(button('← Назад',f'wf:{kind}:{booking_id}:{page-1}'))
    if (page+1)*PAGE_SIZE<len(choices):nav.append(button('Далее →',f'wf:{kind}:{booking_id}:{page+1}'))
    if nav: rows.append(nav)
    rows.append([button('К заявке',f'sw:open:{booking_id}')])
    await message.answer(title,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith('wf:'))
async def staff_workflow_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,'operator'):
        return await query.answer('Доступ только для сотрудников',show_alert=True)
    parts=query.data.split(':');action=parts[1] if len(parts)>1 else '';actor=query.from_user.id
    try:
        if action=='save' and len(parts)==3: return await staff_workflow_save(query,state,parts[2])
        if len(parts)<3: raise ValueError('Действие недоступно')
        booking_id=int(parts[2]);booking=await asyncio.to_thread(get_booking,booking_id)
        if not booking: raise ValueError('Заявка не найдена')
        if action in {'assignees','findings'} and len(parts)==4:
            await staff_choices(query.message,actor,booking_id,int(parts[3]),action)
            return await query.answer()
        if action=='assignee' and len(parts)==4:
            if not await asyncio.to_thread(staff_allows,actor,'manager'): raise PermissionError('Нужна роль менеджера')
            target=int(parts[3]); candidates=await asyncio.to_thread(staff_assignees)
            candidate=next((item for item in candidates if item['id']==target),None)
            if not candidate: raise ValueError('Сотрудник больше недоступен')
            await state.clear();await state.update_data(workflow_operation='assignee',workflow_booking=booking_id,workflow_target=target,workflow_previous=booking.assignee_id)
            await query.answer();return await staff_workflow_confirmation(query.message,state,f"Передать заявку сотруднику {candidate['name']}?")
        if action in {'fix','decline','rework'} and len(parts)==3:
            if action in {'fix','decline'} and not await asyncio.to_thread(staff_allows,actor,'manager'): raise PermissionError('Нужна роль менеджера')
            allowed={'fix':{'pending','confirmed'},'decline':{'pending','needs_changes','confirmed'},'rework':{'confirmed','preparing','ready','return_inspection'}}
            if booking.status not in allowed[action]: raise Conflict('Действие недоступно на текущем этапе')
            await state.clear();await state.update_data(workflow_operation=action,workflow_booking=booking_id,workflow_before=workflow_snapshot(booking),workflow_status=booking.status)
            await state.set_state(StaffWorkflow.comment);await query.answer()
            return await query.message.answer('Введите обязательный комментарий до 2000 символов. Не включайте паспортные данные и фотографии. Отмена: /cancel_booking.')
        if action=='finding' and len(parts)==4:
            if booking.status!='return_inspection':raise Conflict('Результат доступен при проверке возврата')
            asset_id=int(parts[3]);asset=next((item for item in booking.assets if item.equipment_id==asset_id),None)
            if not asset: raise ValueError('Экземпляр не назначен заявке')
            data=await asyncio.to_thread(handover_state,booking_id)
            snapshot=next((item for item in data.get('snapshot',[]) if item.get('id')==asset_id),{})
            features='; '.join(str(item.get('description','')) for item in snapshot.get('features',[])) or ('снимок отсутствовал' if data.get('legacy_snapshot_unknown') else 'особенностей нет')
            rows=[[button('Старая особенность',f'wf:kind:{booking_id}:{asset_id}:existing')],[button('Новое повреждение',f'wf:kind:{booking_id}:{asset_id}:damage')],[button('Утеря',f'wf:kind:{booking_id}:{asset_id}:lost')]]
            await query.answer();return await query.message.answer('При выдаче: '+html.escape(features[:2500]),parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        if action=='kind' and len(parts)==5:
            asset_id=int(parts[3]);kind=parts[4]
            if booking.status!='return_inspection' or kind not in {'existing','damage','lost'} or not any(item.equipment_id==asset_id for item in booking.assets):
                raise Conflict('Действие устарело. Откройте заявку заново')
            await state.clear();await state.update_data(workflow_operation='finding',workflow_booking=booking_id,workflow_asset=asset_id,workflow_kind=kind)
            await state.set_state(StaffWorkflow.comment);await query.answer()
            return await query.message.answer('Опишите результат до 2000 символов. Отмена: /cancel_booking.')
        raise ValueError('Действие недоступно')
    except (ValueError,Conflict,PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


async def staff_workflow_confirmation(message,state,prompt):
    nonce=secrets.token_hex(4);await state.update_data(workflow_nonce=nonce);await state.set_state(StaffWorkflow.confirm)
    await message.answer(prompt,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Подтвердить',f'wf:save:{nonce}')]]))


@router.message(StaffWorkflow.comment)
async def staff_workflow_comment(message: Message,state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'operator'):
        await state.clear();return await message.answer('Действие доступно сотруднику в личном чате.')
    data=await state.get_data();operation=data['workflow_operation']
    if operation in {'fix','decline'} and not await asyncio.to_thread(staff_allows,message.from_user.id,'manager'):
        await state.clear();return await message.answer('Нужна роль менеджера.')
    text=(message.text or '').strip()
    if not text or len(text)>2000:return await message.answer('Введите текст длиной до 2000 символов.')
    await state.update_data(workflow_comment=text)
    await staff_workflow_confirmation(message,state,{'fix':'Отправить клиенту запрос исправления?','decline':'Отклонить заявку?','rework':'Вернуть заявку на доработку?','finding':'Сохранить результат проверки возврата?'}[operation])


async def staff_workflow_save(query,state,nonce):
    async with _staff_workflow_locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data();actor=query.from_user.id
        if await state.get_state()!=StaffWorkflow.confirm.state or data.get('workflow_nonce')!=nonce:
            raise Conflict('Действие устарело. Откройте заявку заново')
        operation=data['workflow_operation'];booking_id=data['workflow_booking']
        role='manager' if operation in {'assignee','fix','decline'} else 'operator'
        if not await asyncio.to_thread(staff_allows,actor,role):raise PermissionError('Недостаточно прав')
        actor_name=(getattr(query.from_user,'full_name','') or '').strip() or f'оператор {actor}'
        if operation=='assignee':
            from .rental import reassign_booking
            await asyncio.to_thread(reassign_booking,booking_id,actor,data['workflow_target'],data['workflow_previous'],True)
        elif operation=='fix':
            from .booking_changes import propose_change
            await asyncio.to_thread(propose_change,booking_id,actor,'client_fix',data['workflow_comment'],None,data['workflow_before'])
        elif operation=='decline':
            from .booking_changes import decline_request
            await asyncio.to_thread(decline_request,booking_id,actor,data['workflow_comment'],data['workflow_before'])
        elif operation=='rework':
            from .rental import return_for_rework
            target={'confirmed':'pending','preparing':'confirmed','ready':'preparing','return_inspection':'issued'}[data['workflow_status']]
            await asyncio.to_thread(return_for_rework,booking_id,target,data['workflow_comment'],actor,actor_name)
        elif operation=='finding':
            from .handover import record_return_finding
            # Consume the confirmation before append-only recording to prevent duplicate findings on retry.
            await state.clear()
            await asyncio.to_thread(record_return_finding,booking_id,data['workflow_asset'],actor,data['workflow_kind'],data['workflow_comment'])
        else:raise ValueError('Действие недоступно')
        await state.clear();await query.answer('Сохранено')
        await show_staff_booking(query.message,booking_id,actor)
