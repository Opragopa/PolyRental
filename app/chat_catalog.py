"""Catalog operations in Telegram; domain validation stays in the shared services."""
import asyncio
import base64
import html
import secrets
import time

from aiogram import F, Router
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError
from aiohttp import ClientError
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy.exc import IntegrityError

from .catalog_import import MAX_CSV_BYTES, import_catalog_csv, parse_catalog_csv
from .chat_workflows import LimitedPhotoBuffer, PAGE_SIZE, button, private
from .rental import Conflict, delete_dependency, delete_equipment, list_articles, list_dependencies, save_dependency
from .roles import staff_allows

router = Router(name="chat_catalog")
_queries = {}
_locks = {}


class CatalogImport(StatesGroup):
    file = State()
    confirm = State()


class CatalogDependency(StatesGroup):
    input = State()
    confirm = State()


class CatalogEditor(StatesGroup):
    input = State()
    confirm = State()


class CatalogPhoto(StatesGroup):
    upload = State()


class CatalogCategory(StatesGroup):
    input = State()
    confirm = State()


async def allowed(message, actor):
    if not private(message) or not await asyncio.to_thread(staff_allows, actor, "operator"):
        await message.answer("Каталог доступен сотруднику в личном чате.")
        return False
    return True


@router.message(Command("catalog"))
async def catalog_command(message: Message):
    if not await allowed(message, message.from_user.id): return
    _queries[message.from_user.id] = (message.text or "").partition(" ")[2].strip()[:100]
    await catalog_list(message, message.from_user.id, 0)


async def catalog_list(message, actor, page):
    if not await asyncio.to_thread(staff_allows, actor, "operator"): raise PermissionError("Доступ только для сотрудников")
    query = _queries.get(actor, "").casefold()
    articles = await asyncio.to_thread(list_articles)
    def matches(article):
        parts = [article.id, article.sku, article.name, article.kind, article.brand, article.key_spec, article.description]
        parts.extend(value for asset in article.equipment for value in (asset.id, asset.inventory_number, asset.asset_inventory_code, asset.serial_number, asset.storage_location))
        return query in " ".join(str(value or "") for value in parts).casefold()
    articles = [article for article in articles if matches(article)]
    page = max(0, min(page, max(0, (len(articles)-1)//PAGE_SIZE)))
    rows = [[button(f"{article.name} · {article.sku}"[:60], f"cat:article:{article.id}")] for article in articles[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    navigation = []
    if page: navigation.append(button("← Назад", f"cat:page:{page-1}"))
    if (page+1)*PAGE_SIZE < len(articles): navigation.append(button("Далее →", f"cat:page:{page+1}"))
    if navigation: rows.append(navigation)
    rows.append([button("Новая модель", "ce:newarticle"), button("Комплекты", "cat:dependencies:0")])
    text = f"Каталог · страница {page+1}. Найдено моделей: {len(articles)}.\nПоиск: /catalog НАЗВАНИЕ или ID. Импорт: /import_catalog. Связь комплекта: /dependency."
    await message.answer(text, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def article_detail(message, actor, article_id, page=0):
    if not await asyncio.to_thread(staff_allows, actor, "operator"): raise PermissionError("Доступ только для сотрудников")
    article = next((item for item in await asyncio.to_thread(list_articles) if item.id == article_id), None)
    if article is None: raise ValueError("Артикул не найден")
    page = max(0, min(page, max(0,(len(article.equipment)-1)//PAGE_SIZE)))
    text = f"<b>{html.escape(article.name)}</b> · {html.escape(article.sku)}\nID модели: {article.id} · {'в каталоге' if article.is_active else 'скрыт'}\nКатегория: {html.escape(article.category)} · проверка: {html.escape(article.inspection_profile)}\nКомплектация: {html.escape((article.composition or 'не указана')[:1000])}\nЭкземпляров: {len(article.equipment)}"
    rows = [[button(f"{asset.inventory_number} · {asset.condition}"[:60], f"cat:asset:{asset.id}")] for asset in article.equipment[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"cat:article:{article_id}:{page-1}"))
    if (page+1)*PAGE_SIZE < len(article.equipment): nav.append(button("Далее →", f"cat:article:{article_id}:{page+1}"))
    if nav: rows.append(nav)
    rows.append([button("Изменить модель", f"ce:article:{article.id}"), button("Добавить экземпляр", f"ce:newasset:{article.id}")])
    if await asyncio.to_thread(staff_allows,actor,"admin"):
        rows.append([button("Тестовая отметка модели",f"am:article:{article.id}")])
    rows.append([button("Загрузить фото", f"ce:photo:{article.id}"), button("Удалить фото", f"ce:askphoto:{article.id}")])
    rows.append([button("К каталогу", "cat:page:0")])
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def asset_detail(message, actor, asset_id):
    if not await asyncio.to_thread(staff_allows, actor, "operator"): raise PermissionError("Доступ только для сотрудников")
    from .rental import list_equipment
    asset = next((item for item in await asyncio.to_thread(list_equipment) if item.id == asset_id), None)
    if asset is None: raise ValueError("Экземпляр не найден")
    text = f"<b>{html.escape(asset.name)}</b>\nID: {asset.id} · код: {html.escape(asset.inventory_number)}\nСостояние: {html.escape(asset.condition)}\nМесто: {html.escape(asset.storage_location or 'не указано')}\nСерийный номер: {html.escape(asset.serial_number or 'не указан')}\nИнвентарный номер: {html.escape(asset.asset_inventory_code or 'не указан')}"
    rows = [[button("Изменить экземпляр", f"ce:asset:{asset.id}"), button("Удалить экземпляр", f"cat:askdelete:{asset.id}")], [button("Владелец, занятость, особенности", f"iv:menu:{asset.id}")], [button("К модели", f"cat:article:{asset.article_id}")]]
    await message.answer(text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


async def dependencies_list(message, actor, page):
    if not await asyncio.to_thread(staff_allows, actor, "operator"): raise PermissionError("Доступ только для сотрудников")
    entries = await asyncio.to_thread(list_dependencies)
    page = max(0, min(page, max(0,(len(entries)-1)//PAGE_SIZE)))
    rows = [[button(f"{item.parent_article_id} → {item.child_article_id} × {item.quantity}", f"cat:askunlink:{item.parent_article_id}:{item.child_article_id}")] for item in entries[page*PAGE_SIZE:(page+1)*PAGE_SIZE]]
    nav = []
    if page: nav.append(button("← Назад", f"cat:dependencies:{page-1}"))
    if (page+1)*PAGE_SIZE < len(entries): nav.append(button("Далее →", f"cat:dependencies:{page+1}"))
    if nav: rows.append(nav)
    rows.append([button("К каталогу", "cat:page:0")])
    await message.answer("Справочные связи комплектов. Они не добавляют оборудование автоматически. Создать: /dependency. Нажмите связь для удаления.", reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))


@router.callback_query(F.data.startswith("cat:"))
async def catalog_action(query: CallbackQuery):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников", show_alert=True)
    try:
        parts = query.data.split(":"); action = parts[1]; actor = query.from_user.id
        if action == "page" and len(parts)==3:
            await query.answer(); return await catalog_list(query.message, actor, int(parts[2]))
        if action == "article" and len(parts) in (3,4):
            await query.answer(); return await article_detail(query.message, actor, int(parts[2]), int(parts[3]) if len(parts)==4 else 0)
        if action == "asset" and len(parts)==3:
            await query.answer(); return await asset_detail(query.message, actor, int(parts[2]))
        if action == "dependencies" and len(parts)==3:
            await query.answer(); return await dependencies_list(query.message, actor, int(parts[2]))
        if action == "askdelete" and len(parts)==3:
            await query.answer(); return await query.message.answer("Удалить экземпляр? Если у модели не останется экземпляров и истории, она тоже может быть удалена.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Удалить",f"cat:delete:{int(parts[2])}"),button("Назад",f"cat:asset:{int(parts[2])}")]]))
        if action == "delete" and len(parts)==3:
            result = await asyncio.to_thread(delete_equipment, int(parts[2]))
            await query.answer("Экземпляр удалён")
            return await query.message.answer("Экземпляр удалён." + (" Пустая модель также удалена." if result.get("article_deleted") else ""))
        if action == "askunlink" and len(parts)==4:
            parent, child = int(parts[2]), int(parts[3]); await query.answer()
            return await query.message.answer(f"Удалить справочную связь {parent} → {child}?",reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Удалить",f"cat:unlink:{parent}:{child}"),button("Назад","cat:dependencies:0")]]))
        if action == "unlink" and len(parts)==4:
            await asyncio.to_thread(delete_dependency,int(parts[2]),int(parts[3]))
            await query.answer("Связь удалена"); return await dependencies_list(query.message, actor, 0)
        raise ValueError("Действие недоступно")
    except (ValueError, Conflict, PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


@router.message(Command("dependency"))
async def dependency_command(message: Message, state: FSMContext):
    if not await allowed(message, message.from_user.id): return
    await state.clear(); await state.set_state(CatalogDependency.input)
    await message.answer("Укажите ID родительской модели, ID дочерней модели и количество через пробел, например: 12 25 2. Связь справочная. Отмена: /cancel_booking.")


@router.message(CatalogDependency.input)
async def dependency_input(message: Message, state: FSMContext):
    if not await allowed(message, message.from_user.id): await state.clear(); return
    try:
        parent, child, quantity = map(int,(message.text or "").split())
        if parent < 1 or child < 1 or parent == child or not 1 <= quantity <= 30: raise ValueError()
    except ValueError: return await message.answer("Укажите два разных ID и количество от 1 до 30.")
    nonce = secrets.token_hex(4)
    await state.update_data(parent=parent,child=child,quantity=quantity,nonce=nonce)
    await state.set_state(CatalogDependency.confirm)
    await message.answer(f"Сохранить связь {parent} → {child} × {quantity}?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Сохранить",f"cd:save:{nonce}")]]))


@router.callback_query(F.data.startswith("cd:save:"))
async def dependency_save(query: CallbackQuery, state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
        return await query.answer("Доступ только для сотрудников",show_alert=True)
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data = await state.get_data()
        if await state.get_state()!=CatalogDependency.confirm.state or query.data.split(":")[-1]!=data.get("nonce"):
            return await query.answer("Действие устарело",show_alert=True)
        try:
            await asyncio.to_thread(save_dependency,data["parent"],data["child"],data["quantity"],False)
        except ValueError as exc: return await query.answer(str(exc)[:180],show_alert=True)
        await state.clear(); await query.answer("Связь сохранена")
        await query.message.answer("Справочная связь сохранена.")


@router.message(Command("import_catalog"))
async def import_command(message: Message, state: FSMContext):
    if not await allowed(message, message.from_user.id): return
    await state.clear(); await state.set_state(CatalogImport.file)
    await message.answer("Отправьте CSV-файл каталога размером до 1 МБ. Перед импортом покажу число моделей и экземпляров. Отмена: /cancel_booking.")


@router.message(CatalogImport.file)
async def import_file(message: Message, state: FSMContext, bot):
    if not await allowed(message, message.from_user.id): await state.clear(); return
    document = message.document
    if not document or not (document.file_name or "").lower().endswith(".csv"):
        return await message.answer("Пришлите файл с расширением .csv или отмените действие командой /cancel_booking.")
    if document.file_size and document.file_size > MAX_CSV_BYTES:
        return await message.answer("Файл больше 1 МБ. Выберите другой файл.")
    sink = LimitedPhotoBuffer(MAX_CSV_BYTES)
    try:
        await bot.download(document, destination=sink, seek=False)
        raw = sink.getvalue()
        models, assets = await asyncio.to_thread(parse_catalog_csv, raw)
    except ValueError as exc:
        return await message.answer(f"Не удалось проверить файл: {str(exc)[:1000]}")
    except (OSError, TimeoutError, TelegramAPIError, ClientError):
        return await message.answer("Не удалось скачать файл. Проверьте соединение и повторите.")
    nonce = secrets.token_hex(4)
    await state.update_data(csv_data=base64.b64encode(raw).decode("ascii"), csv_nonce=nonce, csv_at=time.time())
    await state.set_state(CatalogImport.confirm)
    await message.answer(f"Проверено: моделей в файле — {len(models)}, экземпляров — {len(assets)}. Дубликаты и совместимость с каталогом будут проверены при сохранении. Импортировать?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Импортировать", f"ci:save:{nonce}")]]))


@router.callback_query(F.data.startswith("ci:save:"))
async def import_save(query: CallbackQuery, state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
        return await query.answer("Доступ только для сотрудников",show_alert=True)
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data = await state.get_data()
        if await state.get_state()!=CatalogImport.confirm.state or query.data.split(":")[-1]!=data.get("csv_nonce") or time.time()-data.get("csv_at",0)>900:
            await state.clear()
            return await query.answer("Файл устарел. Запустите /import_catalog заново",show_alert=True)
        if not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
            await state.clear(); return await query.answer("Доступ только для сотрудников",show_alert=True)
        try:
            raw = base64.b64decode(data["csv_data"],validate=True)
        except (ValueError, KeyError):
            await state.clear(); return await query.answer("Файл недоступен. Загрузите его заново",show_alert=True)
        # Consume the confirmation before the transaction so a retry cannot import twice.
        await state.clear()
        try:
            result = await asyncio.to_thread(import_catalog_csv,raw)
        except (ValueError,IntegrityError) as exc:
            detail = str(exc) if isinstance(exc,ValueError) else "Артикул или инвентарный номер уже существует"
            return await query.answer(f"Импорт не выполнен: {detail}"[:180],show_alert=True)
        await query.answer("Импорт завершён")
        await query.message.answer(f"Добавлено моделей: {result['articles_created']}; экземпляров: {result['equipment_created']}.")


ARTICLE_FIELDS = {"sku": "sku", "name": "name", "kind": "kind", "brand": "brand", "key_spec": "key_spec", "description": "description", "composition": "composition", "category": "category", "inspection_profile": "inspection_profile", "buffer_hours": "buffer_hours", "image_url": "image_url", "active": "is_active"}
ASSET_FIELDS = {"article_id": "article_id", "serial": "serial_number", "inventory_code": "asset_inventory_code", "location": "storage_location", "condition": "condition", "health": "health_percent", "charge": "charge_percent"}


def snapshot_fields(item, fields):
    return {attribute: getattr(item, attribute) for attribute in fields.values()}


def parse_editor_values(text, field_names):
    result = {}
    for line in text.splitlines():
        if not line.strip(): continue
        if "=" not in line: raise ValueError("Каждое поле укажите отдельной строкой в формате поле=значение")
        key, value = line.split("=", 1); key, value = key.strip().lower(), value.strip()
        if key not in field_names or key in result: raise ValueError(f"Неизвестное или повторное поле: {key[:40]}")
        result[key] = "" if value in {"-", "−"} else value
    if not result: raise ValueError("Укажите хотя бы одно поле")
    return result


def editor_payload(kind, base, updates):
    from .miniapp import ArticleRequest, EquipmentRequest
    from pydantic import ValidationError
    fields = ARTICLE_FIELDS if kind == "article" else ASSET_FIELDS
    values = {key: base.get(attribute) for key, attribute in fields.items()}
    for key, value in values.items():
        if value is None and key not in {"health", "charge"}:
            values[key] = ""
    for key, value in updates.items():
        if key in {"health", "charge"} and value == "": values[key] = None
        elif key in {"article_id", "buffer_hours", "health", "charge"}:
            if not value.isascii() or not value.isdigit(): raise ValueError(f"{key}: укажите целое число")
            values[key] = int(value)
        elif key == "active":
            if value.casefold() not in {"да", "нет", "true", "false", "1", "0"}: raise ValueError("active: укажите да или нет")
            values[key] = value.casefold() in {"да", "true", "1"}
        else: values[key] = value
    try:
        model = (ArticleRequest if kind == "article" else EquipmentRequest).model_validate(values)
    except ValidationError as exc:
        raise ValueError("Проверьте обязательные поля, длину значений и допустимые диапазоны") from exc
    if kind == "equipment" and model.condition not in {"available", "maintenance", "retired"}:
        raise ValueError("condition: available, maintenance или retired")
    return model.model_dump(mode="json")


async def editor_start(query, state, action, identifier=None):
    actor = query.from_user.id
    if action in {"article", "newarticle"}:
        kind = "article"
        if action == "newarticle":
            before = None
            base = {"sku":"", "name":"", "kind":"", "brand":"", "key_spec":"", "description":"", "composition":"", "category":"generic", "inspection_profile":"generic", "buffer_hours":24, "image_url":"", "is_active":True}
        else:
            article = next((item for item in await asyncio.to_thread(list_articles) if item.id == identifier), None)
            if article is None: raise ValueError("Модель не найдена")
            before = snapshot_fields(article, ARTICLE_FIELDS); base = before.copy()
    else:
        kind = "equipment"
        if action == "newasset":
            if not any(item.id == identifier for item in await asyncio.to_thread(list_articles)): raise ValueError("Модель не найдена")
            before = None
            base = {"article_id":identifier, "serial_number":None, "asset_inventory_code":None, "storage_location":"", "condition":"available", "health_percent":None, "charge_percent":None}
        else:
            from .rental import list_equipment
            asset = next((item for item in await asyncio.to_thread(list_equipment) if item.id == identifier), None)
            if asset is None: raise ValueError("Экземпляр не найден")
            before = snapshot_fields(asset, ASSET_FIELDS); base = before.copy()
    record_id = identifier if action in {"article", "asset"} else None
    await state.clear(); await state.update_data(editor_kind=kind, editor_id=record_id, editor_before=before, editor_base=base)
    await state.set_state(CatalogEditor.input); await query.answer()
    if kind == "article":
        hint = "Поля: sku, name, kind, brand, key_spec, description, composition, category, inspection_profile, buffer_hours, image_url, active. Категории: /categories. Профиль: generic, camera, optics, light, battery. active: да/нет. Для нового обязательны sku и name."
    else:
        hint = "Поля: article_id, serial, inventory_code, location, condition, health, charge. condition: available, maintenance, retired; health и charge: 0–100."
    await query.message.answer("Пришлите изменяемые поля, каждое с новой строки: поле=значение. Для очистки необязательного поля укажите −. " + hint + " Отмена: /cancel_booking.")


@router.callback_query(F.data.startswith("ce:"))
async def editor_action(query: CallbackQuery, state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows, query.from_user.id, "operator"):
        return await query.answer("Доступ только для сотрудников", show_alert=True)
    parts=query.data.split(":"); action=parts[1] if len(parts)>1 else ""
    try:
        if action == "newarticle" and len(parts)==2: return await editor_start(query,state,action)
        if action in {"article","asset","newasset"} and len(parts)==3: return await editor_start(query,state,action,int(parts[2]))
        if action == "photo" and len(parts)==3:
            article_id=int(parts[2]);
            if not any(item.id == article_id for item in await asyncio.to_thread(list_articles)): raise ValueError("Модель не найдена")
            await state.clear(); await state.update_data(photo_article_id=article_id); await state.set_state(CatalogPhoto.upload)
            await query.answer(); return await query.message.answer("Пришлите фото модели JPEG, PNG или WebP размером до 8 МБ. Новое фото заменит прежнее. Отмена: /cancel_booking.")
        if action == "askphoto" and len(parts)==3:
            article_id=int(parts[2]); await query.answer()
            return await query.message.answer("Удалить фото модели?",reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Удалить", f"ce:delphoto:{article_id}"),button("Назад",f"cat:article:{article_id}")]]))
        if action == "delphoto" and len(parts)==3:
            from .catalog_images import save_image
            await asyncio.to_thread(save_image,int(parts[2]),None,query.from_user.id)
            await query.answer("Фото удалено"); return await article_detail(query.message,query.from_user.id,int(parts[2]))
        if action == "save" and len(parts)==3:
            return await editor_save(query,state,parts[2])
        raise ValueError("Действие недоступно")
    except (ValueError, Conflict, PermissionError) as exc:
        await query.answer(str(exc)[:180],show_alert=True)


@router.message(CatalogEditor.input)
async def editor_input(message: Message, state: FSMContext):
    if not await allowed(message,message.from_user.id): await state.clear(); return
    data=await state.get_data(); kind=data["editor_kind"]
    fields=ARTICLE_FIELDS if kind == "article" else ASSET_FIELDS
    try:
        updates=parse_editor_values(message.text or "",fields)
        payload=editor_payload(kind,data["editor_base"],updates)
    except ValueError as exc: return await message.answer(str(exc))
    nonce=secrets.token_hex(4)
    await state.update_data(editor_payload=payload,editor_nonce=nonce); await state.set_state(CatalogEditor.confirm)
    preview="\n".join(f"{html.escape(key)}: {html.escape(str(payload.get(key,''))[:250])}" for key in updates)
    await message.answer("Проверьте изменения:\n"+preview,parse_mode=ParseMode.HTML,reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Сохранить",f"ce:save:{nonce}")]]))


async def editor_save(query, state, nonce):
    from .rental import save_article, save_equipment
    async with _locks.setdefault(query.from_user.id, asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=CatalogEditor.confirm.state or nonce!=data.get("editor_nonce"):
            raise Conflict("Редактирование устарело. Откройте карточку заново")
        if not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
            raise PermissionError("Доступ только для сотрудников")
        payload=data["editor_payload"]; before=data["editor_before"]; identifier=data["editor_id"]
        # Consume confirmation before the write to prevent duplicate creations on retry.
        await state.clear()
        try:
            if data["editor_kind"]=="article":
                saved=await asyncio.to_thread(save_article,payload["sku"],payload["name"],payload["description"],0,payload["category"],payload["inspection_profile"],payload["buffer_hours"],payload["image_url"],identifier,payload["active"],payload["composition"],payload["kind"],payload["brand"],payload["key_spec"],query.from_user.id,before)
            else:
                saved=await asyncio.to_thread(save_equipment,"","","",0,payload["condition"],identifier,None,payload["article_id"],payload["location"],payload["health"],payload["charge"],payload["serial"],payload["inventory_code"],before)
        except IntegrityError as exc:
            raise ValueError("Артикул или инвентарный номер уже существует") from exc
        await query.answer("Сохранено")
        if data["editor_kind"]=="article": return await article_detail(query.message,query.from_user.id,saved)
        return await asset_detail(query.message,query.from_user.id,saved)


@router.message(Command("categories"))
async def categories_command(message: Message):
    if not await allowed(message,message.from_user.id): return
    from .catalog_categories import list_categories
    categories=await asyncio.to_thread(list_categories)
    text="\n".join(f"{html.escape(item['code'])} · {html.escape(item['name'])}" for item in categories)
    await message.answer((text or "Категорий нет") + "\nСоздать категорию: /new_category",parse_mode=ParseMode.HTML)


@router.message(Command("new_category"))
async def category_command(message: Message, state: FSMContext):
    if not await allowed(message,message.from_user.id): return
    await state.clear(); await state.set_state(CatalogCategory.input)
    await message.answer("Введите название новой категории до 100 символов. Отмена: /cancel_booking.")


@router.message(CatalogCategory.input)
async def category_input(message: Message, state: FSMContext):
    if not await allowed(message,message.from_user.id): await state.clear(); return
    name=" ".join((message.text or "").split())
    if not name or len(name)>100: return await message.answer("Введите название категории до 100 символов.")
    nonce=secrets.token_hex(4); await state.update_data(category_name=name,category_nonce=nonce); await state.set_state(CatalogCategory.confirm)
    await message.answer(f"Создать категорию «{name}»?",reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button("Создать",f"cc:save:{nonce}")]]))


@router.callback_query(F.data.startswith("cc:save:"))
async def category_save(query: CallbackQuery,state: FSMContext):
    if not private(query) or not await asyncio.to_thread(staff_allows,query.from_user.id,"operator"):
        return await query.answer("Доступ только для сотрудников",show_alert=True)
    async with _locks.setdefault(query.from_user.id,asyncio.Lock()):
        data=await state.get_data()
        if await state.get_state()!=CatalogCategory.confirm.state or query.data.split(":")[-1]!=data.get("category_nonce"):
            return await query.answer("Действие устарело",show_alert=True)
        from .catalog_categories import create_category
        try: result=await asyncio.to_thread(create_category,data["category_name"],query.from_user.id)
        except (ValueError,PermissionError) as exc: return await query.answer(str(exc)[:180],show_alert=True)
        await state.clear(); await query.answer("Категория создана")
        await query.message.answer(f"Категория создана: {result['name']} · код {result['code']}")


@router.message(CatalogPhoto.upload)
async def catalog_photo_upload(message: Message, state: FSMContext, bot):
    if not await allowed(message,message.from_user.id): await state.clear(); return
    data=await state.get_data(); attachment=None
    if message.photo: attachment=message.photo[-1]
    elif message.document and message.document.mime_type in {"image/jpeg","image/png","image/webp"}: attachment=message.document
    if not attachment: return await message.answer("Пришлите JPEG, PNG или WebP либо отмените действие командой /cancel_booking.")
    from .catalog_images import MAX_UPLOAD, save_image
    if attachment.file_size and attachment.file_size>MAX_UPLOAD: return await message.answer("Фото больше 8 МБ.")
    sink=LimitedPhotoBuffer(MAX_UPLOAD)
    try:
        await bot.download(attachment,destination=sink,seek=False)
        await asyncio.to_thread(save_image,data["photo_article_id"],sink.getvalue(),message.from_user.id)
    except (ValueError,PermissionError) as exc: return await message.answer(f"Фото не сохранено: {str(exc)[:1000]}")
    except (OSError,TimeoutError,TelegramAPIError,ClientError): return await message.answer("Не удалось загрузить фото. Проверьте соединение и повторите.")
    await state.clear(); await message.answer("Фото модели сохранено.")
    await article_detail(message,message.from_user.id,data["photo_article_id"])
