"""Persistent category names; equipment inspection profiles remain independent."""
import unicodedata
from uuid import uuid4
from sqlalchemy import inspect, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from .db import Article, CatalogCategory, Session

DEFAULT_CATEGORIES = {"generic": "Оборудование", "camera": "Камера", "optics": "Оптика",
                      "light": "Свет", "battery": "Питание", "accessory": "Аксессуар", "kits": "Готовые комплекты"}


def normalize_name(name):
    return " ".join(unicodedata.normalize("NFKC", name).split()).casefold()


def seed_categories(connection):
    if not connection.scalar(select(CatalogCategory.code).limit(1)):
        for code, name in DEFAULT_CATEGORIES.items():
            connection.execute(insert(CatalogCategory).values(code=code, name=name, normalized_name=normalize_name(name)).on_conflict_do_nothing())
    article_categories = select(Article.category).distinct()
    if any(column["name"] == "archived_at" for column in inspect(connection).get_columns("articles")):
        article_categories = article_categories.where(Article.archived_at.is_(None))
    for code in connection.scalars(article_categories):
        if code and code not in DEFAULT_CATEGORIES:
            connection.execute(insert(CatalogCategory).values(code=code, name=code, normalized_name=normalize_name(code)).on_conflict_do_nothing())


def list_categories():
    from .catalog_images import preview_data
    with Session() as session:
        return [{"code": row.code, "name": row.name, "parent_code": row.parent_code, "icon": row.icon, "image_data": preview_data(row.image_webp)} for row in session.scalars(select(CatalogCategory).order_by(CatalogCategory.name))]


def category_exists(code):
    with Session() as session:
        return session.get(CatalogCategory, code) is not None


def delete_category(code, actor_id):
    from .inventory import require_role
    from .rental import Conflict
    require_role(actor_id, "operator")
    if code == "generic":
        raise Conflict("Основную категорию оборудования удалить нельзя")
    with Session.begin() as session:
        row = session.get(CatalogCategory, code, with_for_update=True)
        if not row:
            raise ValueError("Категория не найдена")
        if session.scalar(select(Article.id).where(Article.category == code, Article.archived_at.is_(None)).limit(1)):
            raise Conflict("Сначала перенесите артикулы в другую категорию")
        if session.scalar(select(CatalogCategory.code).where(CatalogCategory.parent_code == code).limit(1)):
            raise Conflict("Сначала удалите вложенные категории")
        session.delete(row)


def create_category(name, actor_id, parent_code=None, icon="equipment"):
    from .inventory import require_role
    require_role(actor_id)
    name = " ".join(unicodedata.normalize("NFKC", name).split())
    if not name or len(name) > 100 or any(unicodedata.category(char).startswith("C") for char in name):
        raise ValueError("Укажите название категории от 1 до 100 символов")
    if parent_code and not category_exists(parent_code):
        raise ValueError("Родительская категория не найдена")
    if icon not in {"equipment", "camera", "lens", "light", "battery", "accessory"}:
        raise ValueError("Неизвестная пиктограмма")
    try:
        with Session.begin() as session:
            if parent_code and not session.get(CatalogCategory, parent_code, with_for_update=True):
                raise ValueError("Родительская категория не найдена")
            row = CatalogCategory(code=f"custom_{uuid4().hex}", name=name, normalized_name=normalize_name(name), parent_code=parent_code or None, icon=icon)
            session.add(row)
        return {"code": row.code, "name": row.name, "parent_code": row.parent_code, "icon": row.icon, "image_data": ""}
    except IntegrityError as exc:
        raise ValueError("Категория с таким названием уже существует") from exc


def valid_category_name(name):
    name = " ".join(unicodedata.normalize("NFKC", name).split())
    if not name or len(name) > 100 or any(unicodedata.category(char).startswith("C") for char in name):
        raise ValueError("Укажите название категории от 1 до 100 символов")
    return name


def update_category(code, name, actor_id):
    from .inventory import require_role
    require_role(actor_id, "operator")
    name = valid_category_name(name)
    try:
        with Session.begin() as session:
            row = session.get(CatalogCategory, code, with_for_update=True)
            if not row:
                raise ValueError("Категория не найдена")
            row.name, row.normalized_name = name, normalize_name(name)
    except IntegrityError as exc:
        raise ValueError("Категория с таким названием уже существует") from exc


def save_category_image(code, raw, actor_id):
    from .inventory import require_role
    from .catalog_images import thumbnail
    require_role(actor_id, "operator")
    preview = thumbnail(raw) if raw is not None else None
    with Session.begin() as session:
        row = session.get(CatalogCategory, code, with_for_update=True)
        if not row:
            raise ValueError("Категория не найдена")
        row.image_webp = preview
    return preview


def edit_category(code, name, raw, remove_photo, actor_id):
    """Change name and optional preview together, or leave both untouched."""
    from .inventory import require_role
    from .catalog_images import thumbnail
    require_role(actor_id, "operator")
    name = valid_category_name(name)
    if raw is not None and remove_photo:
        raise ValueError("Выберите новое фото или удалите текущее")
    preview = thumbnail(raw) if raw is not None else None
    try:
        with Session.begin() as session:
            row = session.get(CatalogCategory, code, with_for_update=True)
            if not row:
                raise ValueError("Категория не найдена")
            row.name, row.normalized_name = name, normalize_name(name)
            if raw is not None or remove_photo:
                row.image_webp = preview
    except IntegrityError as exc:
        raise ValueError("Категория с таким названием уже существует") from exc
