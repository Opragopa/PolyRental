"""Employee inventory workflows, backed by the same services as the Mini App."""
import asyncio
import html
import secrets
from datetime import datetime
from zoneinfo import ZoneInfo

from aiogram import F, Router
from aiogram.enums import ParseMode
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .chat_workflows import PAGE_SIZE, button, private
from .inventory import inventory_details, save_feature, save_owner
from .rental import Conflict, list_equipment
from .roadmap import external_blocks, release_external_block, save_external_block
from .roles import staff_allows

router = Router(name="chat_inventory")
_locks = {}
MOSCOW = ZoneInfo("Europe/Moscow")


class InventoryEdit(StatesGroup):
    input = State()
    confirm = State()


def owner_snapshot(equipment_id):
    from .db import EquipmentOwner, Session
    with Session() as session:
        owner = session.get(EquipmentOwner, equipment_id)
        return {"name":owner.name,"contact":owner.contact} if owner else {}


async def inventory_menu(message, actor, asset_id):
    if not await asyncio.to_thread(staff_allows,actor,"operator"): raise PermissionError("Доступ только для сотрудников")
    asset = next((item for item in await asyncio.to_thread(list_equipment) if item.id == asset_id),None)
    if not asset: raise ValueError("Экземпляр не найден")
    info = await asyncio.to_thread(inventory_details, asset_id)
    text = f"<b>{html.escape(asset.name)}</b> · {html.escape(asset.inventory_number)}\nВладелец: {html.escape(info.get('owner') or 'не указан')}\nКонтакт: {html.escape(info.get('owner_contact') or 'не указан')}\nОсобенностей: {len(info['features'])}"
    rows = [[button("Особенности",f"iv:features:{asset_id}:0"),button("Занятость",f"iv:blocks:{asset_id}:0")]]
    if await asyncio.to_thread(staff_allows,actor,"manager"): rows.append([button("Изменить владельца",f"iv:owner:{asset_id}")])
    rows.append([button("К экземпляру",f"cat:asset:{asset_id}")])
    await message.answer(text,parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def feature_list(message, actor, asset_id, page=0):
    info=await asyncio.to_thread(inventory_details,asset_id); features=info['features']
    page=max(0,min(page,max(0,(len(features)-1)//PAGE_SIZE)))
    rows=[[button(f"№{item['id']} · {item['description']}"[:60],f"iv:feature:{asset_id}:{item['id']}")] for item in features[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page: nav.append(button("← Назад",f"iv:features:{asset_id}:{page-1}"))
    if (page+1)*PAGE_SIZE<len(features): nav.append(button("Далее →",f"iv:features:{asset_id}:{page+1}"))
    if nav: rows.append(nav)
    rows.extend([[button("Добавить особенность",f"iv:addfeature:{asset_id}")],[button("К экземпляру",f"iv:menu:{asset_id}")]])
    await message.answer(f"Особенности · страница {page+1}",reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def block_list(message, actor, asset_id, page=0):
    blocks=await asyncio.to_thread(external_blocks,asset_id)
    page=max(0,min(page,max(0,(len(blocks)-1)//PAGE_SIZE)))
    rows=[[button(f"№{row['id']} · {row['start'][:10]} — {row['end'][:10]}",f"iv:block:{asset_id}:{row['id']}")] for row in blocks[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav=[]
    if page: nav.append(button("← Назад",f"iv:blocks:{asset_id}:{page-1}"))
    if (page+1)*PAGE_SIZE<len(blocks): nav.append(button("Далее →",f"iv:blocks:{asset_id}:{page+1}"))
    if nav: rows.append(nav)
    if await asyncio.to_thread(staff_allows,actor,"manager"): rows.append([button("Отметить занятость",f"iv:addblock:{asset_id}")])
    rows.append([button("К экземпляру",f"iv:menu:{asset_id}")])
    await message.answer(f"Внешняя занятость · страница {page+1}",reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def begin_edit(query,state,asset_id,operation,**values):
    required="manager" if operation in {"owner","block"} else "admin" if operation in {"feature_edit","feature_delete"} else "operator"
    if not await asyncio.to_thread(staff_allows,query.from_user.id,required): raise PermissionError("Недостаточно прав для этого действия")
    await state.clear(); await state.update_data(asset_id=asset_id,operation=operation,**values)
    await state.set_state(InventoryEdit.input)
    prompts={"owner":"Введите имя владельца и контакт через |, например: Организация | +7... . Чтобы очистить, отправьте − | −.",
             "block":"Введите начало, конец и причину через |: ДД.ММ.ГГГГ ЧЧ:ММ | ДД.ММ.ГГГГ ЧЧ:ММ | причина. Время московское, причина видна клиентам.",
             "feature_add":"Опишите особенность экземпляра до 2000 символов.","feature_edit":"Введите новое описание особенности до 2000 символов."}
    await query.answer(); await query.message.answer(prompts[operation]+" Отмена: /cancel_booking.")


async def confirm_draft(message,state,data):
    nonce=secrets.token_hex(4); await state.update_data(inventory_nonce=nonce); await state.set_state(InventoryEdit.confirm)
    summary={"owner":"Сохранить владельца и контакт?","block":"Отметить занятость экземпляра?","feature_add":"Добавить особенность?","feature_edit":"Изменить особенность?","feature_delete":"Удалить особенность?","block_release":"Освободить экземпляр от этого периода?"}[data['operation']]
    await message.answer(summary,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Подтвердить",f"iv:save:{nonce}")]]))


@router.callback_query(F.data.startswith("iv:"))
async def inventory_action(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
        return await query.answer("Доступ только для сотрудников",show_alert=True)
    try:
        parts=query.data.split(":");action=parts[1];actor=query.from_user.id
        if action=="save" and len(parts)==3: return await inventory_save(query,state,parts[2])
        if len(parts)<3: raise ValueError("Действие недоступно")
        asset_id=int(parts[2])
        if action=="menu" and len(parts)==3:
            await query.answer();return await inventory_menu(query.message,actor,asset_id)
        if action=="features" and len(parts)==4:
            await query.answer();return await feature_list(query.message,actor,asset_id,int(parts[3]))
        if action=="blocks" and len(parts)==4:
            await query.answer();return await block_list(query.message,actor,asset_id,int(parts[3]))
        if action=="owner" and len(parts)==3:
            before=await asyncio.to_thread(owner_snapshot,asset_id)
            return await begin_edit(query,state,asset_id,"owner",before=before)
        if action=="addfeature" and len(parts)==3: return await begin_edit(query,state,asset_id,"feature_add")
        if action=="addblock" and len(parts)==3: return await begin_edit(query,state,asset_id,"block")
        if action in {"feature","editfeature","askfeaturedelete"} and len(parts)==4:
            feature_id=int(parts[3]); info=await asyncio.to_thread(inventory_details,asset_id)
            feature=next((item for item in info['features'] if item['id']==feature_id),None)
            if not feature: raise ValueError("Особенность не найдена")
            if action=="editfeature": return await begin_edit(query,state,asset_id,"feature_edit",feature_id=feature_id,before=feature['description'],source=feature['source'])
            if action=="askfeaturedelete":
                if not await asyncio.to_thread(staff_allows,actor,"admin"): raise PermissionError("Удалять особенности может администратор")
                await state.clear();await state.update_data(asset_id=asset_id,operation="feature_delete",feature_id=feature_id,before=feature['description'],source=feature['source'])
                await query.answer();return await confirm_draft(query.message,state,await state.get_data())
            rows=[]
            if await asyncio.to_thread(staff_allows,actor,"admin"):
                rows=[[button("Изменить",f"iv:editfeature:{asset_id}:{feature_id}"),button("Удалить",f"iv:askfeaturedelete:{asset_id}:{feature_id}")]]
            rows.append([button("К особенностям",f"iv:features:{asset_id}:0")])
            await query.answer();return await query.message.answer(html.escape(feature['description']),parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        if action in {"block","askrelease"} and len(parts)==4:
            block_id=int(parts[3]); blocks=await asyncio.to_thread(external_blocks,asset_id)
            block=next((item for item in blocks if item['id']==block_id),None)
            if not block: raise ValueError("Занятость не найдена или уже завершилась")
            if action=="askrelease":
                if not await asyncio.to_thread(staff_allows,actor,"manager"): raise PermissionError("Недостаточно прав")
                await state.clear();await state.update_data(asset_id=asset_id,operation="block_release",block_id=block_id)
                await query.answer();return await confirm_draft(query.message,state,await state.get_data())
            rows=[]
            if await asyncio.to_thread(staff_allows,actor,"manager"): rows.append([button("Освободить",f"iv:askrelease:{asset_id}:{block_id}")])
            rows.append([button("К списку",f"iv:blocks:{asset_id}:0")])
            text=f"Занято: {html.escape(block['start'])} — {html.escape(block['end'])}\nПричина: {html.escape(block['reason'])}"
            await query.answer();return await query.message.answer(text,parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))
        raise ValueError("Действие недоступно")
    except (ValueError,Conflict,PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


@router.message(InventoryEdit.input)
async def inventory_input(message: Message,state: FSMContext):
    if not private(message) or not await asyncio.to_thread(staff_allows,message.from_user.id,"operator"):
        await state.clear(); return await message.answer("Действие доступно сотруднику в личном чате.")
    data=await state.get_data(); operation=data['operation']; text=(message.text or "").strip()
    required="manager" if operation in {"owner","block"} else "admin" if operation=="feature_edit" else "operator"
    if not await asyncio.to_thread(staff_allows,message.from_user.id,required):
        await state.clear();return await message.answer("Недостаточно прав для этого действия.")
    try:
        if operation=="owner":
            fields=[value.strip() for value in text.split("|")]
            if len(fields)!=2: raise ValueError("Укажите имя и контакт через |")
            name,contact=("" if value in {"-","−"} else value for value in fields)
            if len(name)>200 or len(contact)>300 or (contact and not name): raise ValueError("Укажите имя до 200 и контакт до 300 символов")
            values={"name":name,"contact":contact}
        elif operation=="block":
            fields=[value.strip() for value in text.split("|",2)]
            if len(fields)!=3: raise ValueError("Укажите начало, конец и причину через |")
            start=datetime.strptime(fields[0],"%d.%m.%Y %H:%M").replace(tzinfo=MOSCOW)
            end=datetime.strptime(fields[1],"%d.%m.%Y %H:%M").replace(tzinfo=MOSCOW)
            if start>=end or not fields[2] or len(fields[2])>2000: raise ValueError("Проверьте сроки и причину до 2000 символов")
            values={"start":start.isoformat(),"end":end.isoformat(),"reason":fields[2]}
        elif operation in {"feature_add","feature_edit"}:
            if not text or len(text)>2000: raise ValueError("Введите описание до 2000 символов")
            values={"description":text}
        else: raise ValueError("Действие недоступно")
    except ValueError as exc: return await message.answer(f"Не удалось проверить данные: {exc}")
    await state.update_data(values=values)
    await confirm_draft(message,state,await state.get_data())


async def inventory_save(query,state,nonce):
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=InventoryEdit.confirm.state or data.get('inventory_nonce')!=nonce:
            raise Conflict("Действие устарело. Откройте карточку заново")
        operation=data['operation'];actor=query.from_user.id;asset_id=data['asset_id']
        required="manager" if operation in {"owner","block","block_release"} else "admin" if operation in {"feature_edit","feature_delete"} else "operator"
        if not await asyncio.to_thread(staff_allows,actor,required): raise PermissionError("Недостаточно прав")
        values=data.get('values',{}); warnings=[]
        if operation=="owner":
            await asyncio.to_thread(save_owner,asset_id,values['name'],values['contact'],actor,data['before'])
        elif operation=="block":
            # A fresh confirmation is required after any failure to avoid duplicate intervals.
            await state.clear()
            result=await asyncio.to_thread(save_external_block,asset_id,datetime.fromisoformat(values['start']),datetime.fromisoformat(values['end']),values['reason'],actor,True)
            warnings=result['warnings']
        elif operation=="block_release":
            await asyncio.to_thread(release_external_block,data['block_id'],actor)
        elif operation in {"feature_add","feature_edit","feature_delete"}:
            if operation=="feature_add": await state.clear()
            await asyncio.to_thread(save_feature,asset_id,values.get('description',''),actor,data.get('feature_id'),operation=="feature_delete",data.get('source','catalog'),data.get('before'))
        else: raise ValueError("Действие недоступно")
        await state.clear();await query.answer(f"Сохранено. Есть пересечения: {len(warnings)}." if warnings else "Сохранено",show_alert=bool(warnings))
        return await inventory_menu(query.message,actor,asset_id)
