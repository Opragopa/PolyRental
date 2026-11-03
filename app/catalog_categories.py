"""Persistent category names; equipment inspection profiles remain independent."""
import unicodedata
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from .db import Article, CatalogCategory, Session

DEFAULT_CATEGORIES = {"generic": "Оборудование", "camera": "Камера", "optics": "Оптика",
                      "light": "Свет", "battery": "Питание", "accessory": "Аксессуар"}


def normalize_name(name):
    return " ".join(unicodedata.normalize("NFKC", name).split()).casefold()


def seed_categories(connection):
    for code, name in DEFAULT_CATEGORIES.items():
        connection.execute(insert(CatalogCategory).values(code=code, name=name, normalized_name=normalize_name(name)).on_conflict_do_nothing())
    for code in connection.scalars(select(Article.category).distinct()):
        if code and code not in DEFAULT_CATEGORIES:
            connection.execute(insert(CatalogCategory).values(code=code, name=code, normalized_name=normalize_name(code)).on_conflict_do_nothing())


def list_categories():
    with Session() as session:
        return [{"code": row.code, "name": row.name, "parent_code": row.parent_code, "icon": row.icon} for row in session.scalars(select(CatalogCategory).order_by(CatalogCategory.name))]


def category_exists(code):
    with Session() as session:
        return session.get(CatalogCategory, code) is not None


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
            row = CatalogCategory(code=f"custom_{uuid4().hex}", name=name, normalized_name=normalize_name(name), parent_code=parent_code or None, icon=icon)
            session.add(row)
        return {"code": row.code, "name": row.name, "parent_code": row.parent_code, "icon": row.icon}
    except IntegrityError as exc:
        raise ValueError("Категория с таким названием уже существует") from exc
