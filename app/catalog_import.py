"""Atomic import of catalog models and concrete equipment from CSV."""

import csv
import hashlib
import io
from decimal import Decimal
from urllib.parse import urlparse
from uuid import uuid4

from sqlalchemy import select, text

from .db import Article, Equipment, Session, CatalogCategory
from .catalog_categories import category_exists


MAX_CSV_BYTES = 1024 * 1024
MAX_ROWS = 500
REQUIRED = {"sku", "name"}
OPTIONAL = {"location", "condition", "description", "composition", "category",
            "inspection_profile", "buffer_hours", "image_url", "active", "health", "charge",
            "serial", "inventory_code", "kind", "brand", "key_spec"}
MODEL_FIELDS = {"description", "composition", "category", "inspection_profile", "buffer_hours",
                "image_url", "active", "kind", "brand", "key_spec"}
DEFAULTS = {"kind": "", "brand": "", "key_spec": "", "description": "", "composition": "", "category": "generic",
            "inspection_profile": "generic", "buffer_hours": 24, "image_url": "", "active": True}
PROFILES = {"generic", "camera", "optics", "light", "battery"}
CONDITIONS = {"available", "maintenance", "retired"}


def _inventory_category(kind):
    normalized = " ".join(kind.casefold().split())
    if any(word in normalized for word in ("микрофон", "наушник", "рекордер", "аудио")):
        return "sound"
    if any(word in normalized for word in ("штатив", "монопод", "стойка")):
        return "support"
    if any(word in normalized for word in ("кабель", "адаптер", "переходник")):
        return "cables"
    if "камера" in normalized:
        return "camera"
    if "объектив" in normalized or "линза" in normalized:
        return "optics"
    if "аккумулятор" in normalized or "батаре" in normalized:
        return "battery"
    if any(word in normalized for word in ("свет", "лампа", "осветител", "прожектор")):
        return "light"
    if any(word in normalized for word in ("адаптер", "кабель", "штатив", "креплен", "микрофон", "наушник")):
        return "accessory"
    return "generic"


def _text(value, label, limit, line, required=False):
    result = (value or "").strip()
    if required and not result:
        raise ValueError(f"Строка {line}: заполните {label}")
    if len(result) > limit or "\x00" in result:
        raise ValueError(f"Строка {line}: неверное значение {label}")
    return result


def _optional_identifier(value):
    value = (value or "").strip()
    return "" if value in {"", "-", "—"} else value


def _source_sku(kind, model):
    normalized = " ".join(f"{kind} {model}".casefold().split())
    return f"SOURCE-{hashlib.sha256(normalized.encode()).hexdigest()[:16].upper()}"


def _parse_inventory_csv(source):
    reader = csv.DictReader(io.StringIO(source, newline=""), strict=True)
    required = {"Наименование", "Модель", "S/N", "Инвентаризационный номер/ Код ОС"}
    if not required <= set(reader.fieldnames or []):
        raise ValueError("Опись должна содержать Наименование, Модель, S/N и Инвентаризационный номер/ Код ОС")
    models, assets = {}, []
    for row in reader:
        line = reader.line_num
        if None in row:
            raise ValueError(f"Строка {line}: слишком много значений")
        if not any((value or "").strip() for key, value in row.items() if key != "№"):
            continue
        kind = _text(row.get("Наименование"), "Наименование", 200, line, True)
        model_name = _text(row.get("Модель"), "Модель", 200, line) or kind
        sku = _source_sku(kind, model_name)
        model = models.setdefault(sku, {"name": model_name, "fields": {
            "description": kind, "category": _inventory_category(kind),
        }, "line": line})
        if model["name"] != model_name or model["fields"]["description"] != kind:
            raise ValueError(f"Строка {line}: у модели разные типы оборудования")
        assets.append({"line": line, "sku": sku, "serial": _optional_identifier(row.get("S/N")),
                       "inventory_code": _optional_identifier(row.get("Инвентаризационный номер/ Код ОС")),
                       "location": "", "condition": "available", "health": None, "charge": None})
        if len(assets) > MAX_ROWS:
            raise ValueError(f"CSV-файл может содержать не больше {MAX_ROWS} экземпляров")
    if not assets:
        raise ValueError("CSV-файл не содержит оборудования")
    return models, assets


def _percentage(value, label, line):
    if not value:
        return None
    try:
        result = int(value)
    except ValueError as exc:
        raise ValueError(f"Строка {line}: {label} должно быть числом от 0 до 100") from exc
    if not 0 <= result <= 100:
        raise ValueError(f"Строка {line}: {label} должно быть числом от 0 до 100")
    return result


def _model_value(field, raw, line):
    if field in {"kind", "brand", "key_spec"}:
        return _text(raw, field, {"kind": 80, "brand": 100, "key_spec": 120}[field], line)
    if field in {"description", "composition"}:
        return _text(raw, field, 4000, line)
    if field == "image_url":
        url = _text(raw, field, 500, line)
        if url and (urlparse(url).scheme != "https" or not urlparse(url).netloc):
            raise ValueError(f"Строка {line}: image_url должен быть HTTPS-ссылкой")
        return url
    if field == "category":
        if not category_exists(raw):
            raise ValueError(f"Строка {line}: неизвестная категория {raw}")
        return raw
    if field == "inspection_profile":
        if raw not in PROFILES:
            raise ValueError(f"Строка {line}: неизвестный профиль проверки {raw}")
        return raw
    if field == "buffer_hours":
        try:
            hours = int(raw)
        except ValueError as exc:
            raise ValueError(f"Строка {line}: buffer_hours должен быть числом от 0 до 168") from exc
        if not 0 <= hours <= 168:
            raise ValueError(f"Строка {line}: buffer_hours должен быть числом от 0 до 168")
        return hours
    if raw.lower() in {"true", "1", "yes", "да"}:
        return True
    if raw.lower() in {"false", "0", "no", "нет"}:
        return False
    raise ValueError(f"Строка {line}: active должен быть true или false")


def parse_catalog_csv(data: bytes):
    if not data or len(data) > MAX_CSV_BYTES:
        raise ValueError("CSV-файл должен быть непустым и не больше 1 МБ")
    try:
        source = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("Сохраните CSV-файл в кодировке UTF-8") from exc
    first_line = source.splitlines()[0] if source.splitlines() else ""
    if "Наименование" in first_line and "Инвентаризационный номер/ Код ОС" in first_line:
        return _parse_inventory_csv(source)
    delimiter = ";" if first_line.count(";") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(source, newline=""), delimiter=delimiter, strict=True)
    headers = [header.strip().lower() for header in (reader.fieldnames or [])]
    if len(headers) != len(set(headers)) or not REQUIRED <= set(headers) or set(headers) - REQUIRED - OPTIONAL:
        raise ValueError("CSV должен содержать колонки sku и name; serial и inventory_code необязательны")
    reader.fieldnames = headers
    models = {}
    assets = []
    try:
        for row in reader:
            line = reader.line_num
            if None in row:
                raise ValueError(f"Строка {line}: слишком много значений")
            if not any((value or "").strip() for value in row.values()):
                continue
            if len(assets) >= MAX_ROWS:
                raise ValueError(f"CSV-файл может содержать не больше {MAX_ROWS} экземпляров")
            sku = _text(row["sku"], "sku", 80, line, True)
            name = _text(row["name"], "name", 200, line, True)
            serial = _optional_identifier(_text(row.get("serial"), "serial", 80, line))
            inventory_code = _optional_identifier(_text(row.get("inventory_code"), "inventory_code", 80, line))
            model = models.setdefault(sku, {"name": name, "fields": {}, "line": line})
            if model["name"] != name:
                raise ValueError(f"Строка {line}: у артикула {sku} разные названия")
            for field in MODEL_FIELDS & set(headers):
                raw = (row[field] or "").strip()
                if not raw:
                    continue
                value = _model_value(field, raw, line)
                if field in model["fields"] and model["fields"][field] != value:
                    raise ValueError(f"Строка {line}: у артикула {sku} разные значения {field}")
                model["fields"][field] = value
            condition = _text(row.get("condition"), "condition", 30, line) or "available"
            if condition not in CONDITIONS:
                raise ValueError(f"Строка {line}: неизвестное состояние {condition}")
            assets.append({"line": line, "sku": sku, "serial": serial, "inventory_code": inventory_code,
                           "location": _text(row.get("location"), "location", 120, line),
                           "condition": condition,
                           "health": _percentage((row.get("health") or "").strip(), "health", line),
                           "charge": _percentage((row.get("charge") or "").strip(), "charge", line)})
    except csv.Error as exc:
        raise ValueError(f"Некорректный CSV: {exc}") from exc
    if not assets:
        raise ValueError("CSV-файл не содержит оборудования")
    return models, assets


def import_catalog_csv(data: bytes):
    models, assets = parse_catalog_csv(data)
    with Session.begin() as session:
        for code in sorted({(DEFAULTS | model["fields"])["category"] for model in models.values()}):
            if not session.get(CatalogCategory, code, with_for_update=True):
                raise ValueError("Категория не найдена")
        existing_articles = {article.sku: article for article in session.scalars(
            select(Article).where(Article.sku.in_(models))).all()}
        for article in sorted(existing_articles.values(), key=lambda item: item.id):
            session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": article.id})
            session.refresh(article)
            if article.archived_at is not None:
                raise ValueError(f"Артикул {article.sku} удалён из каталога и не может быть импортирован")
        inventory_codes = [asset["inventory_code"] for asset in assets if asset["inventory_code"]]
        duplicate_codes = {code for code in inventory_codes if inventory_codes.count(code) > 1}
        if duplicate_codes:
            raise ValueError(f"Инвентарный код повторяется в файле: {sorted(duplicate_codes)[0]}")
        existing_codes = set(session.scalars(select(Equipment.asset_inventory_code).where(
            Equipment.asset_inventory_code.in_(inventory_codes))).all()) if inventory_codes else set()
        if existing_codes:
            raise ValueError(f"Инвентарный код уже есть в каталоге: {sorted(existing_codes)[0]}")
        created_articles = 0
        for sku, model in models.items():
            article = existing_articles.get(sku)
            if article:
                if article.name != model["name"]:
                    raise ValueError(f"Артикул {sku} уже существует с другим названием")
                for field, value in model["fields"].items():
                    attribute = "is_active" if field == "active" else field
                    if getattr(article, attribute) != value:
                        raise ValueError(f"Артикул {sku} уже существует с другим значением {field}")
            else:
                fields = DEFAULTS | model["fields"]
                article = Article(sku=sku, name=model["name"], hourly_rate=Decimal("0"),
                                  is_test=sku.upper().startswith("TEST-"),
                                  description=fields["description"], composition=fields["composition"],
                                  kind=fields["kind"], brand=fields["brand"], key_spec=fields["key_spec"],
                                  category=fields["category"], inspection_profile=fields["inspection_profile"],
                                  buffer_hours=fields["buffer_hours"], image_url=fields["image_url"],
                                  is_active=fields["active"])
                session.add(article)
                session.flush()
                existing_articles[sku] = article
                created_articles += 1
        for asset in assets:
            article = existing_articles[asset["sku"]]
            session.add(Equipment(inventory_number=f"ASSET-{uuid4().hex[:12].upper()}",
                                  serial_number=asset["serial"] or None,
                                  asset_inventory_code=asset["inventory_code"] or None, name=article.name,
                                  description=article.description, image_url=article.image_url,
                                  hourly_rate=article.hourly_rate, article_id=article.id,
                                  condition=asset["condition"], storage_location=asset["location"],
                                  health_percent=asset["health"], charge_percent=asset["charge"]))
        session.flush()
        return {"articles_created": created_articles, "equipment_created": len(assets)}
