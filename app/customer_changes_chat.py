"""The same request/decision workflow in authenticated private Telegram chats."""
import asyncio
import html

from aiogram import F, Router
from aiogram.enums import ParseMode
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .chat_workflows import button, owned_booking, private, show_customer_booking, show_staff_booking
from .customer_changes import decide_request, request_changes, request_overview, view_request
from .rental import Conflict

router = Router(name="customer_change_requests")


class ChangeReason(StatesGroup):
    reason = State()
    confirm = State()


@router.callback_query(F.data.startswith("ccr:"))
async def request_action(query: CallbackQuery, state: FSMContext):
    if not private(query):
        return await query.answer("Откройте личный чат с ботом", show_alert=True)
    try:
        parts = query.data.split(":")
        action, booking_id = parts[1], int(parts[2])
        actor = query.from_user.id
        if action == "ask" and len(parts) == 3:
            booking = await owned_booking(booking_id, actor)
            if not (await asyncio.to_thread(request_overview, booking))["can_request"]:
                raise Conflict("Запрос сейчас недоступен. Обновите заявку")
            await state.clear()
            await state.update_data(change_booking=booking_id)
            await state.set_state(ChangeReason.reason)
            await query.answer()
            return await query.message.answer("Что вы хотите изменить и почему? Напишите обязательную причину (до 2000 символов). Дождитесь решения оператора; до одобрения заявка не изменится.",
                reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Отмена", f"ccr:cancel:{booking_id}")]]))
        if action == "cancel" and len(parts) == 3:
            await state.clear()
            await query.answer("Запрос не отправлен")
            return await show_customer_booking(query.message, booking_id, actor)
        if action == "send" and len(parts) == 3:
            data = await state.get_data()
            if await state.get_state() != ChangeReason.confirm.state or data.get("change_booking") != booking_id:
                raise Conflict("Подтверждение устарело; откройте заявку заново")
            await asyncio.to_thread(request_changes, booking_id, actor, data.get("change_reason", ""))
            await state.clear()
            await query.answer("Запрос отправлен оператору")
            return await show_customer_booking(query.message, booking_id, actor)
        if action == "review" and len(parts) == 4:
            request = await asyncio.to_thread(view_request, booking_id, actor)
            if not request or request["id"] != int(parts[3]) or request["status"] != "pending":
                raise Conflict("Запрос уже обработан или устарел")
            from .roles import staff_allows
            if not await asyncio.to_thread(staff_allows, actor, "operator"):
                raise PermissionError("Нужна роль оператора")
            await query.answer()
            return await query.message.answer(f"<b>Запрос клиента на изменения</b>\nПричина: {html.escape(request['reason'])}\n\nПри одобрении клиент исправит заявку и отправит её на повторное подтверждение. При отказе заявка останется подтверждённой.",
                parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                    [button("Подтвердить запрос", f"ccr:approve:{booking_id}:{request['id']}"), button("Отклонить запрос", f"ccr:reject:{booking_id}:{request['id']}")]]))
        if action in {"approve", "reject"} and len(parts) == 4:
            await asyncio.to_thread(decide_request, booking_id, int(parts[3]), actor, action == "approve")
            await query.answer("Запрос одобрен" if action == "approve" else "Запрос отклонён")
            return await show_staff_booking(query.message, booking_id, actor)
        raise ValueError("Действие недоступно")
    except (ValueError, IndexError, Conflict, PermissionError) as exc:
        await query.answer(str(exc), show_alert=True)


@router.message(ChangeReason.reason)
async def reason_message(message: Message, state: FSMContext):
    if not private(message):
        return await message.answer("Откройте личный чат с ботом.")
    reason = (message.text or "").strip()
    if not reason or len(reason) > 2000:
        return await message.answer("Обязательно напишите причину текстом, до 2000 символов.")
    data = await state.get_data()
    await owned_booking(data["change_booking"], message.from_user.id)
    await state.update_data(change_reason=reason)
    await state.set_state(ChangeReason.confirm)
    await message.answer(f"Причина: {html.escape(reason)}\n\nОтправить запрос оператору?", parse_mode=ParseMode.HTML,
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Отправить запрос", f"ccr:send:{data['change_booking']}"),
                                                          button("Отмена", f"ccr:cancel:{data['change_booking']}")]]))
