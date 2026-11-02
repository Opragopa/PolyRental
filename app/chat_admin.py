"""Test markers, hidden requests and client access management in private chat."""
import asyncio
import secrets

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .chat_workflows import PAGE_SIZE, button, private
from .rental import Conflict, get_booking, list_articles, list_hidden_test_bookings
from .roles import staff_allows

router=Router(name='chat_admin')
_locks={}


class Moderation(StatesGroup):
    confirm=State()


async def hidden_list(message,actor,page):
    if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
    bookings=await asyncio.to_thread(list_hidden_test_bookings)
    page=max(0,min(page,max(0,(len(bookings)-1)//PAGE_SIZE)))
    rows=[[button(f"{booking.human_number or booking.id} · {booking.status}",f'am:restore:{booking.id}')] for booking in bookings[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page:nav.append(button('← Назад',f'am:hidden:{page-1}'))
    if (page+1)*PAGE_SIZE<len(bookings):nav.append(button('Далее →',f'am:hidden:{page+1}'))
    if nav:rows.append(nav)
    if not rows:return await message.answer('Скрытых тестовых заявок нет.')
    await message.answer(f'Скрытые тестовые заявки · страница {page+1}. Нажмите заявку, чтобы восстановить.',reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.message(Command('hidden_tests'))
async def hidden_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'admin'):
        return await message.answer('Раздел доступен администратору в личном чате.')
    await hidden_list(message,message.from_user.id,0)


async def moderation_draft(query,state,operation,target,before,prompt,**extra):
    nonce=secrets.token_hex(4)
    await state.clear();await state.update_data(moderation_operation=operation,moderation_target=target,moderation_before=before,moderation_nonce=nonce,**extra)
    await state.set_state(Moderation.confirm);await query.answer()
    await query.message.answer(prompt,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Подтвердить',f'am:save:{nonce}')]]))


@router.callback_query(F.data.startswith('am:'))
async def moderation_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,'operator'):
        return await query.answer('Доступ только для сотрудников',show_alert=True)
    parts=query.data.split(':');action=parts[1] if len(parts)>1 else '';actor=query.from_user.id
    try:
        if action=='save' and len(parts)==3:return await moderation_save(query,state,parts[2])
        if len(parts)!=3:raise ValueError('Действие недоступно')
        target=int(parts[2])
        if action=='hidden':
            await hidden_list(query.message,actor,target);return await query.answer()
        if action=='restore':
            if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
            entries=await asyncio.to_thread(list_hidden_test_bookings)
            if not any(row.id==target for row in entries):raise Conflict('Заявка уже восстановлена или недоступна')
            return await moderation_draft(query,state,'restore',target,None,'Вернуть тестовую заявку в списки?')
        if action=='article':
            if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
            article=next((row for row in await asyncio.to_thread(list_articles) if row.id==target),None)
            if not article:raise ValueError('Модель не найдена')
            before=bool(article.is_test)
            return await moderation_draft(query,state,'article',target,before,'Снять тестовую отметку модели?' if before else 'Отметить модель как тестовую?')
        booking=await asyncio.to_thread(get_booking,target)
        if not booking:raise ValueError('Заявка не найдена')
        if action=='booking':
            if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
            rows=[[button('Снять тестовую отметку' if booking.is_test else 'Отметить тестовой',f'am:flag:{target}')],
                  [button('Ограничить / разрешить бронирование',f'am:block:{target}')],
                  [button('К заявке',f'sw:open:{target}')]]
            await query.answer();return await query.message.answer('Административные действия по заявке:',reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        if action=='flag':
            if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
            before=bool(booking.is_test)
            return await moderation_draft(query,state,'flag',target,before,'Снять тестовую отметку заявки?' if before else 'Отметить заявку тестовой?')
        if action=='hide':
            if not booking.is_test:raise Conflict('Скрыть можно только тестовую заявку')
            return await moderation_draft(query,state,'hide',target,True,'Скрыть тестовую заявку из списков? Администратор сможет восстановить её.')
        if action=='block':
            if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
            from .client_profile import profile_state
            profile=await asyncio.to_thread(profile_state,booking.customer_id);before=not profile['client_allowed']
            prompt='Снять запрет на бронирование для клиента заявки?' if before else 'Запретить клиенту заявки создавать бронирования?'
            return await moderation_draft(query,state,'block',target,before,prompt,moderation_customer=booking.customer_id)
        raise ValueError('Действие недоступно')
    except (ValueError,Conflict,PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


async def moderation_save(query,state,nonce):
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data();actor=query.from_user.id
        if await state.get_state()!=Moderation.confirm.state or data.get('moderation_nonce')!=nonce:
            raise Conflict('Действие устарело. Откройте карточку заново')
        operation=data['moderation_operation'];target=data['moderation_target'];before=data['moderation_before']
        if not await asyncio.to_thread(staff_allows,actor,'operator' if operation=='hide' else 'admin'):
            raise PermissionError('Недостаточно прав')
        if operation=='flag':
            from .rental import set_booking_test_flag
            await asyncio.to_thread(set_booking_test_flag,target,actor,not before,before)
        elif operation=='article':
            from .rental import set_article_test_flag
            await asyncio.to_thread(set_article_test_flag,target,actor,not before,before)
        elif operation=='hide':
            from .rental import hide_test_booking
            await asyncio.to_thread(hide_test_booking,target,actor)
        elif operation=='restore':
            from .rental import restore_booking
            entries=await asyncio.to_thread(list_hidden_test_bookings)
            if not any(row.id==target for row in entries):raise Conflict('Заявка уже восстановлена или недоступна')
            await asyncio.to_thread(restore_booking,target,actor)
        elif operation=='block':
            from .client_profile import set_client_block
            booking=await asyncio.to_thread(get_booking,target)
            if not booking or booking.customer_id!=data['moderation_customer']:raise Conflict('Заявка изменилась. Откройте её заново')
            await asyncio.to_thread(set_client_block,booking.customer_id,actor,not before,before)
        else:raise ValueError('Действие недоступно')
        await state.clear();await query.answer('Сохранено')
        await query.message.answer('Изменение сохранено.')
