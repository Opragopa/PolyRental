"""Profile and administrator settings through authenticated private chats."""
import asyncio
import html
import secrets

from aiogram import F, Router
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .chat_workflows import PAGE_SIZE, button, private
from .client_profile import profile_state, set_reminders_enabled
from .rental import Conflict
from .roles import configured_ids, staff_allows

router = Router(name="chat_settings")
_locks = {}


class AdminSettings(StatesGroup):
    signer_name = State()
    confirm = State()


def staff_snapshot():
    from .db import Session, StaffRole, TrustedSigner
    with Session() as session:
        rows=[]
        for uid in sorted(configured_ids('ADMIN_IDS')):
            role=session.get(StaffRole,uid);signer=session.get(TrustedSigner,uid)
            rows.append({'id':uid,'role':role.role if role else None,'signer':{'full_name':signer.full_name,'active':signer.active} if signer else {}})
        return rows


async def reminder_menu(message,user_id):
    profile=await asyncio.to_thread(profile_state,user_id)
    enabled=profile['reminders_enabled']
    rows=[[button('Выключить' if enabled else 'Включить',f"rem:set:{'off' if enabled else 'on'}")]]
    await message.answer(f"Необязательные напоминания {'включены' if enabled else 'выключены'}. Важные сообщения о заявках приходят независимо от этой настройки.",reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.message(Command('reminders'))
async def reminder_command(message: Message):
    if not private(message):return await message.answer('Откройте личный чат с ботом.')
    await reminder_menu(message,message.from_user.id)


@router.callback_query(F.data.startswith('rem:set:'))
async def reminder_action(query: CallbackQuery):
    if not private(query):return await query.answer('Откройте личный чат с ботом',show_alert=True)
    value=query.data.rsplit(':',1)[-1]
    if value not in {'on','off'}:return await query.answer('Действие недоступно',show_alert=True)
    await asyncio.to_thread(set_reminders_enabled,query.from_user.id,value=='on')
    await query.answer('Настройка сохранена')
    await reminder_menu(query.message,query.from_user.id)


@router.message(Command('staff_settings'))
async def staff_settings_command(message: Message):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'admin'):
        return await message.answer('Настройки сотрудников доступны администратору в личном чате.')
    await staff_list(message,message.from_user.id,0)


async def staff_list(message,actor,page):
    if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
    staff=await asyncio.to_thread(staff_snapshot);page=max(0,min(page,max(0,(len(staff)-1)//PAGE_SIZE)))
    rows=[[button(f"{row['signer'].get('full_name') or row['id']} · {row['role'] or 'без роли'}"[:60],f"as:open:{row['id']}")] for row in staff[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page:nav.append(button('← Назад',f'as:page:{page-1}'))
    if (page+1)*PAGE_SIZE<len(staff):nav.append(button('Далее →',f'as:page:{page+1}'))
    if nav:rows.append(nav)
    if not rows:return await message.answer('Нет настроенных сотрудников.')
    await message.answer(f'Сотрудники · страница {page+1}. Доступ к персональным данным назначается отдельно.',reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def staff_detail(message,actor,target):
    if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
    row=next((item for item in await asyncio.to_thread(staff_snapshot) if item['id']==target),None)
    if not row:raise ValueError('Сотрудник не найден в ADMIN_IDS')
    signer=row['signer']
    text=f"Сотрудник {target}\nРоль: {row['role'] or 'не назначена'}\nДоверенный подписант: {signer.get('full_name') or 'не указан'} · {'активен' if signer.get('active') else 'неактивен'}"
    rows=[[button('Оператор',f'as:role:{target}:operator'),button('Менеджер',f'as:role:{target}:manager'),button('Администратор',f'as:role:{target}:admin')],
          [button('Настроить подписанта',f'as:signer:{target}')],[button('К списку','as:page:0')]]
    await message.answer(text,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def settings_confirmation(message,state,prompt):
    nonce=secrets.token_hex(4);await state.update_data(settings_nonce=nonce);await state.set_state(AdminSettings.confirm)
    await message.answer(prompt,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button('Подтвердить',f'as:save:{nonce}')]]))


@router.callback_query(F.data.startswith('as:'))
async def admin_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,'admin'):
        return await query.answer('Нужна роль администратора',show_alert=True)
    parts=query.data.split(':');action=parts[1] if len(parts)>1 else '';actor=query.from_user.id
    try:
        if action=='save' and len(parts)==3:return await admin_save(query,state,parts[2])
        if action=='page' and len(parts)==3:
            await staff_list(query.message,actor,int(parts[2]));return await query.answer()
        if action=='open' and len(parts)==3:
            await staff_detail(query.message,actor,int(parts[2]));return await query.answer()
        if action in {'role','signer'} and len(parts) in {3,4}:
            target=int(parts[2]);row=next((item for item in await asyncio.to_thread(staff_snapshot) if item['id']==target),None)
            if not row:raise ValueError('Сотрудник не найден в ADMIN_IDS')
            if action=='role' and len(parts)==4:
                role=parts[3]
                if role not in {'operator','manager','admin'}:raise ValueError('Недопустимая роль')
                if target==actor and role!='admin':raise Conflict('Собственную роль администратора понизить нельзя')
                await state.clear();await state.update_data(settings_action='role',settings_target=target,settings_role=role,settings_before=row['role'])
                await query.answer();return await settings_confirmation(query.message,state,f'Назначить сотруднику {target} роль {role}?')
            if action=='signer' and len(parts)==3:
                await state.clear();await state.update_data(settings_action='signer',settings_target=target,settings_before=row['signer'])
                await state.set_state(AdminSettings.signer_name);await query.answer()
                return await query.message.answer('Введите ФИО подписанта и статус через |, например: Иванов Иван | да. Для отключения укажите то же имя и нет. Отмена: /cancel_booking.')
        raise ValueError('Действие недоступно')
    except (ValueError,PermissionError,Conflict) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


@router.message(AdminSettings.signer_name)
async def signer_input(message: Message,state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,'admin'):
        await state.clear();return await message.answer('Нужна роль администратора.')
    fields=[field.strip() for field in (message.text or '').split('|')]
    if len(fields)!=2 or not fields[0] or len(fields[0])>200 or fields[1].casefold() not in {'да','нет'}:
        return await message.answer('Укажите ФИО до 200 символов и да или нет через |.')
    await state.update_data(settings_name=fields[0],settings_active=fields[1].casefold()=='да')
    await settings_confirmation(message,state,'Сохранить данные доверенного подписанта?')


async def admin_save(query,state,nonce):
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data();actor=query.from_user.id
        if await state.get_state()!=AdminSettings.confirm.state or data.get('settings_nonce')!=nonce:
            raise Conflict('Настройка устарела. Откройте её заново')
        if not await asyncio.to_thread(staff_allows,actor,'admin'):raise PermissionError('Нужна роль администратора')
        if data['settings_action']=='role':
            from .roles import set_staff_role
            await asyncio.to_thread(set_staff_role,actor,data['settings_target'],data['settings_role'],data['settings_before'],True)
        elif data['settings_action']=='signer':
            from .handover import set_trusted_signer
            await asyncio.to_thread(set_trusted_signer,actor,data['settings_target'],data['settings_name'],data['settings_active'],data['settings_before'])
        else:raise ValueError('Действие недоступно')
        await state.clear();await query.answer('Сохранено')
        await staff_detail(query.message,actor,data['settings_target'])
