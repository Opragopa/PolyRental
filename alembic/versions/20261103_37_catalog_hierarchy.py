"""Category hierarchy and classification of imported equipment."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_37"
down_revision = "20261102_36"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("catalog_categories", sa.Column("parent_code", sa.String(40), sa.ForeignKey("catalog_categories.code"), nullable=True))
    op.add_column("catalog_categories", sa.Column("icon", sa.String(30), nullable=False, server_default="equipment"))
    bind = op.get_bind()
    for code, name, icon, parent in [("camera", "Камеры", "camera", None), ("optics", "Оптика", "lens", None), ("light", "Свет", "light", None), ("battery", "Питание", "battery", None), ("accessory", "Аксессуары", "accessory", None), ("generic", "Другое оборудование", "equipment", None), ("sound", "Звук", "accessory", None), ("support", "Штативы и опоры", "accessory", None), ("cables", "Кабели и адаптеры", "accessory", "accessory"), ("media", "Носители и картридеры", "equipment", None), ("computer", "Компьютерное оборудование", "equipment", None), ("monitors", "Мониторы", "equipment", None), ("furniture", "Мебель и оформление", "equipment", None)]:
        bind.execute(sa.text("INSERT INTO catalog_categories (code, name, normalized_name, icon, parent_code) VALUES (:code, :name, :normalized, :icon, :parent) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, normalized_name=EXCLUDED.normalized_name, icon=EXCLUDED.icon, parent_code=EXCLUDED.parent_code"), dict(code=code, name=name, normalized=name.casefold(), icon=icon, parent=parent))
    rows = bind.execute(sa.text("SELECT id, name, description, kind, category FROM articles"))
    for row in rows:
        text = " ".join(str(x or "").lower() for x in (row.description, row.kind, row.name))
        category = row.category
        if any(x in text for x in ("клетка", "держатель", "площадка для камеры")): category = "accessory"
        elif any(x in text for x in ("си-стенд", "стабилизатор")): category = "support"
        elif any(x in text for x in ("карта памяти", "картридер", "накопитель", "жесткий диск")): category = "media"
        elif any(x in text for x in ("клавиатура", "мышь компьютерная", "оперативная память", "процессор", "корпус")): category = "computer"
        elif "монитор" in text or "monitor" in text: category = "monitors"
        elif any(x in text for x in ("вывеска", "полка", "стол", "шкаф")): category = "furniture"
        elif any(x in text for x in ("блок питания", "зарядн", "сетевой фильтр")): category = "battery"
        elif any(x in text for x in ("октабокс", "блок управления")): category = "light"
        elif any(x in text for x in ("микрофон", "наушник", "рекордер", "аудио", "microphone", "audio")): category = "sound"
        elif any(x in text for x in ("штатив", "монопод", "tripod", "стойка")): category = "support"
        elif any(x in text for x in ("кабель", "переходник", "адаптер", "cable")): category = "cables"
        elif any(x in text for x in ("объектив", "линза", "lens")): category = "optics"
        elif any(x in text for x in ("аккумулятор", "батаре", "battery", "зарядн")): category = "battery"
        elif any(x in text for x in ("свет", "лампа", "осветител", "прожектор", "softbox")): category = "light"
        elif any(x in text for x in ("камера", "camera", "фотоаппарат")): category = "camera"
        bind.execute(sa.text("UPDATE articles SET category=:category WHERE id=:id"), {"category": category, "id": row.id})


def downgrade():
    pass
