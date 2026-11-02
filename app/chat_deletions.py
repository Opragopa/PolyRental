"""Deferred deletion and undo in the private staff chat."""
import asyncio
import secrets
from uuid import UUID, uuid4

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message
from sqlalchemy import and_, exists, func, or_, select

from .chat_workflows import PAGE_SIZE, button, private
from .db import Booking, BookingAsset, BookingLine, DeletionIntent, Session
from .rental import Conflict, cancel_deletion_intent, create_deletion_intent, get_booking
from .roles import staff_allows

router=Router(name='chat_deletions')
_locks={}


class DeletionDraft(StatesGroup):
    confirm=State()


def pending_intents(actor):
    with Session() as session:
        return [{'id':row.id,'booking_id':row.booking_id,'target_type':row.target_type,'target_id':row.target_id,'status':row.status}
                for row in session.scalars(select(DeletionIntent).where(DeletionIntent.actor_id==actor,DeletionIntent.status=='pending').order_by(DeletionIntent.created_at.desc()).limit(20))]


async def pending_list(message,actor):
    entries=await asyncio.to_thread(pending_intents,actor)
    if not entries:return await message.answer('Ожидающих удалений нет. Для восстановления администратором: /deleted.')
    rows=[[button(f"Отменить · заявка {entry['booking_id']} · {entry['target_type']}",f"dl:undo:{entry['booking_id']}:{UUID(entry['id']).hex}")] for entry in entries]
    await message.answer('Ожидающие удаления:',reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.message(Command('deletions'))
async def deletions_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'operator'):
        return await message.answer('Раздел доступен сотруднику в личном чате.')
    await pending_list(message,message.from_user.id)


def deleted_intents(page):
    with Session() as session:
        active_booking = exists(select(Booking.id).where(Booking.id == DeletionIntent.booking_id,
                                                         Booking.deleted_at.is_(None)))
        deleted_booking = exists(select(Booking.id).where(Booking.id == DeletionIntent.booking_id,
                                                          Booking.deleted_at.is_not(None), Booking.deletion_level == 'L1'))
        deleted_line = exists(select(BookingLine.id).where(BookingLine.booking_id == DeletionIntent.booking_id,
                                                            BookingLine.id == DeletionIntent.target_id,
                                                            BookingLine.deleted_at.is_not(None)))
        deleted_asset = exists(select(BookingAsset.equipment_id).where(BookingAsset.booking_id == DeletionIntent.booking_id,
                                                                        BookingAsset.equipment_id == DeletionIntent.target_id,
                                                                        BookingAsset.deleted_at.is_not(None)))
        stmt = (select(DeletionIntent.booking_id, DeletionIntent.target_type, DeletionIntent.target_id)
                .where(DeletionIntent.status == 'committed', or_(
                    and_(DeletionIntent.target_type == 'request', deleted_booking),
                    and_(DeletionIntent.target_type == 'line', active_booking, deleted_line),
                    and_(DeletionIntent.target_type == 'asset', active_booking, deleted_asset)))
                .group_by(DeletionIntent.booking_id, DeletionIntent.target_type, DeletionIntent.target_id)
                .order_by(func.max(DeletionIntent.created_at).desc(), DeletionIntent.booking_id.desc(),
                          DeletionIntent.target_type, DeletionIntent.target_id)
                .offset(page * PAGE_SIZE).limit(PAGE_SIZE + 1))
        return list(session.execute(stmt).all())


async def deleted_list(message, page):
    page = max(0, page)
    entries = await asyncio.to_thread(deleted_intents, page)
    names = {'request': 'Заявка', 'line': 'Позиция', 'asset': 'Экземпляр'}
    rows = [[button(f"{names.get(kind, kind)} · заявка {booking_id}" +
                    (f" · ID {target_id}" if target_id else ''),
                    f'dr:ask:{kind}:{booking_id}:{target_id or 0}')]
            for booking_id, kind, target_id in entries[:PAGE_SIZE]]
    nav = []
    if page: nav.append(button('← Назад', f'dr:list:{page-1}'))
    if len(entries) > PAGE_SIZE: nav.append(button('Далее →', f'dr:list:{page+1}'))
    if nav: rows.append(nav)
    if not rows:
        return await message.answer('Удалённых объектов пока нет.')
    await message.answer('Выберите объект для восстановления:', reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.message(Command('deleted'))
async def deleted_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows, message.from_user.id, 'admin'):
        return await message.answer('Восстановление доступно администратору в личном чате.')
    await deleted_list(message, 0)


@router.callback_query(F.data.startswith('dr:list:'))
async def deleted_page(query: CallbackQuery):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, 'admin'):
        return await query.answer('Нужна роль администратора', show_alert=True)
    try:
        page = int(query.data.rsplit(':', 1)[-1])
        if page < 0 or page > 100000: raise ValueError()
    except ValueError:
        return await query.answer('Страница недоступна', show_alert=True)
    await deleted_list(query.message, page)
    await query.answer()


@router.callback_query(F.data.startswith('dr:ask:'))
async def restore_select(query: CallbackQuery, state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, 'admin'):
        return await query.answer('Нужна роль администратора', show_alert=True)
    try:
        _, _, kind, booking, target = query.data.split(':')
        booking_id, target_id = int(booking), int(target)
        if kind not in {'request', 'line', 'asset'} or booking_id <= 0 or (kind == 'request') != (target_id == 0) or target_id < 0:
            raise ValueError()
    except ValueError:
        return await query.answer('Объект недоступен', show_alert=True)
    nonce = secrets.token_hex(4)
    await state.clear()
    await state.update_data(restore_kind=kind, restore_booking=booking_id,
                            restore_target=target_id or None, restore_nonce=nonce)
    await state.set_state(DeletionDraft.confirm)
    await query.answer()
    await query.message.answer('Восстановить удалённый объект? Доступность и состояние будут проверены.',
                               reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Восстановить', f'dr:save:{nonce}')]]))


async def target_list(message,actor,booking_id,target_type,page):
    if not await asyncio.to_thread(staff_allows,actor,'operator'):raise PermissionError('Доступ только для сотрудников')
    booking=await asyncio.to_thread(get_booking,booking_id)
    if not booking:raise ValueError('Заявка не найдена')
    if target_type=='line' and booking.status=='pending':
        items=booking.lines
        label=lambda item:f"{item.article.name} × {item.quantity}"
        identifier=lambda item:item.id
    elif target_type=='asset' and booking.status=='preparing':
        items=booking.assets
        label=lambda item:f"{item.equipment.name} · {item.equipment.inventory_number}"
        identifier=lambda item:item.equipment_id
    else:raise Conflict('Состояние заявки изменилось')
    page=max(0,min(page,max(0,(len(items)-1)//PAGE_SIZE)))
    rows=[[button(label(item)[:60],f'dl:ask:{target_type}:{booking_id}:{identifier(item)}')] for item in items[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page:nav.append(button('← Назад',f'dl:list:{target_type}:{booking_id}:{page-1}'))
    if (page+1)*PAGE_SIZE<len(items):nav.append(button('Далее →',f'dl:list:{target_type}:{booking_id}:{page+1}'))
    if nav:rows.append(nav)
    rows.append([button('К заявке',f'sw:open:{booking_id}')])
    await message.answer('Выберите позицию для удаления:',reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith('dl:'))
async def deletion_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,'operator'):
        return await query.answer('Доступ только для сотрудников',show_alert=True)
    parts=query.data.split(':');action=parts[1] if len(parts)>1 else '';actor=query.from_user.id
    try:
        if action=='list' and len(parts)==5 and parts[2] in {'line','asset'}:
            await target_list(query.message,actor,int(parts[3]),parts[2],int(parts[4]));return await query.answer()
        if action=='ask' and len(parts)==5 and parts[2] in {'request','line','asset'}:
            target_type=parts[2];booking_id=int(parts[3]);target_id=int(parts[4]) or None
            booking=await asyncio.to_thread(get_booking,booking_id)
            if not booking:raise ValueError('Заявка не найдена')
            if target_type=='request' and (target_id is not None or booking.status not in {'pending','cancelled','expired'}):raise Conflict('Удаление недоступно на текущем этапе')
            if target_type=='line' and (booking.status!='pending' or not any(row.id==target_id for row in booking.lines)):raise Conflict('Позиция или состояние заявки изменились')
            if target_type=='asset' and (booking.status!='preparing' or not any(row.equipment_id==target_id for row in booking.assets)):raise Conflict('Экземпляр или состояние заявки изменились')
            nonce=secrets.token_hex(4);intent_id=str(uuid4())
            await state.clear();await state.update_data(delete_nonce=nonce,delete_intent=intent_id,delete_booking=booking_id,delete_type=target_type,delete_target=target_id)
            await state.set_state(DeletionDraft.confirm);await query.answer()
            return await query.message.answer('Начать удаление? После подтверждения будет короткое время для отмены.',reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Удалить',f'dl:prepare:{nonce}'),button('Назад',f'sw:open:{booking_id}')]]))
        if action=='prepare' and len(parts)==3:
            return await deletion_prepare(query,state,parts[2])
        if action=='undo' and len(parts)==4:
            booking_id=int(parts[2]);intent_id=str(UUID(hex=parts[3]))
            await asyncio.to_thread(cancel_deletion_intent,booking_id,actor,intent_id)
            await query.answer('Удаление отменено');return await query.message.answer('Удаление отменено.')
        if action=='status' and len(parts)==4:
            booking_id=int(parts[2]);intent_id=str(UUID(hex=parts[3]))
            status=await asyncio.to_thread(intent_status,booking_id,actor,intent_id)
            await query.answer();return await query.message.answer({'pending':'Удаление ожидает завершения.','cancelled':'Удаление отменено.','committed':'Удаление сохранено.','failed':'Удаление не выполнено: состояние заявки или права изменились.'}.get(status,'Действие недоступно.'))
        raise ValueError('Действие недоступно')
    except (ValueError,Conflict,PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)
    except Exception:
        await query.answer('Не удалось проверить результат. Откройте /deletions или заявку и проверьте состояние.', show_alert=True)


def intent_status(booking_id,actor,intent_id):
    with Session() as session:
        row=session.get(DeletionIntent,intent_id)
        if not row or row.booking_id!=booking_id or row.actor_id!=actor:raise ValueError('Действие не найдено')
        return row.status


async def deletion_prepare(query,state,nonce):
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data();actor=query.from_user.id
        if await state.get_state()!=DeletionDraft.confirm.state or data.get('delete_nonce')!=nonce:raise Conflict('Действие устарело. Откройте заявку заново')
        if not await asyncio.to_thread(staff_allows,actor,'operator'):raise PermissionError('Доступ только для сотрудников')
        result=await asyncio.to_thread(create_deletion_intent,data['delete_booking'],actor,data['delete_intent'],data['delete_type'],data['delete_target'])
        await state.clear();await query.answer('Удаление запланировано')
        uid=UUID(data['delete_intent']).hex;booking_id=data['delete_booking']
        rows=[[button('Отменить удаление',f'dl:undo:{booking_id}:{uid}')],[button('Проверить статус',f'dl:status:{booking_id}:{uid}')]]
        await query.message.answer(f"Удаление будет выполнено через {result['undo_seconds']} с. Отмена: /deletions. Восстановление администратором: /deleted.",reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.message(Command('restore_request','restore_line','restore_asset'))
async def restore_command(message: Message,state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'admin'):
        return await message.answer('Восстановление доступно администратору в личном чате.')
    parts=(message.text or '').split();command=parts[0].split('@')[0]
    kind={'/restore_request':'request','/restore_line':'line','/restore_asset':'asset'}.get(command)
    try:
        if kind is None or len(parts)!=(2 if kind=='request' else 3):raise ValueError()
        booking_id=int(parts[1]);target_id=int(parts[2]) if len(parts)==3 else None
        if booking_id<=0 or (target_id is not None and target_id<=0):raise ValueError()
    except ValueError:return await message.answer('Формат: /restore_request ID или /restore_line ID_ЗАЯВКИ ID_ПОЗИЦИИ, /restore_asset ID_ЗАЯВКИ ID_ЭКЗЕМПЛЯРА.')
    nonce=secrets.token_hex(4);await state.clear();await state.update_data(restore_kind=kind,restore_booking=booking_id,restore_target=target_id,restore_nonce=nonce);await state.set_state(DeletionDraft.confirm)
    await message.answer('Восстановить удалённый объект? Доступность и состояние будут проверены.',reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Восстановить',f'dr:save:{nonce}')]]))


@router.callback_query(F.data.startswith('dr:save:'))
async def restore_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,'admin'):
        return await query.answer('Нужна роль администратора',show_alert=True)
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=DeletionDraft.confirm.state or data.get('restore_nonce')!=query.data.rsplit(':',1)[-1]:
            return await query.answer('Действие устарело',show_alert=True)
        try:
            kind=data['restore_kind'];booking_id=data['restore_booking'];target=data['restore_target'];actor=query.from_user.id
            if kind=='request':
                from .rental import restore_booking
                await asyncio.to_thread(restore_booking,booking_id,actor)
            elif kind=='line':
                from .rental import set_booking_line_deleted
                await asyncio.to_thread(set_booking_line_deleted,booking_id,target,actor,False)
            elif kind=='asset':
                from .rental import set_booking_asset_deleted
                await asyncio.to_thread(set_booking_asset_deleted,booking_id,target,actor,False)
            else:raise ValueError('Действие недоступно')
        except (ValueError,Conflict,PermissionError) as exc:return await query.answer(str(exc)[:180],show_alert=True)
        except Exception:
            return await query.answer('Не удалось проверить результат. Откройте /deleted или заявку и проверьте состояние.', show_alert=True)
        await state.clear();await query.answer('Восстановлено');await query.message.answer('Объект восстановлен.')
