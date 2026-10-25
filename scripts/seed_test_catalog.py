"""Idempotently add a clearly marked demonstration catalog."""

from sqlalchemy import select

from app.db import Article, Equipment, Session, init_db
from app.rental import save_article, save_dependency, save_equipment


ARTICLES = [
    ("TEST-CAM-ALEXA", "[ТЕСТ] ARRI Alexa Mini LF", "Кинокамера для проверки сценария бронирования", "3500", "camera", "camera", 24),
    ("TEST-LENS-2470", "[ТЕСТ] Sigma 24–70 mm T2.9", "Зум-объектив, байонет PL", "800", "optics", "optics", 24),
    ("TEST-LIGHT-600D", "[ТЕСТ] Aputure LS 600d Pro", "Светодиодный прибор с блоком управления", "1100", "light", "light", 12),
    ("TEST-BAT-V150", "[ТЕСТ] V-Mount 150 Wh", "Аккумулятор для камеры и света", "350", "battery", "battery", 12),
    ("TEST-TRIPOD-18", "[ТЕСТ] Sachtler Video 18", "Штатив с жидкостной головой", "600", "accessory", "generic", 24),
]

ASSETS = {
    "TEST-CAM-ALEXA": [("TEST-ALEXA-001", "A-01"), ("TEST-ALEXA-002", "A-02")],
    "TEST-LENS-2470": [("TEST-LENS-001", "B-01"), ("TEST-LENS-002", "B-02")],
    "TEST-LIGHT-600D": [("TEST-LIGHT-001", "C-01"), ("TEST-LIGHT-002", "C-02")],
    "TEST-BAT-V150": [("TEST-BAT-001", "D-01"), ("TEST-BAT-002", "D-02"),
                       ("TEST-BAT-003", "D-03"), ("TEST-BAT-004", "D-04")],
    "TEST-TRIPOD-18": [("TEST-TRIPOD-001", "E-01"), ("TEST-TRIPOD-002", "E-02")],
}


def main():
    init_db()
    ids = {}
    for sku, name, description, rate, category, profile, buffer_hours in ARTICLES:
        with Session() as session:
            existing = session.scalar(select(Article).where(Article.sku == sku))
            article_id = existing.id if existing else None
        ids[sku] = save_article(sku, name, description, rate, category, profile,
                                buffer_hours, "", article_id, True)
    for sku, assets in ASSETS.items():
        for serial, location in assets:
            with Session() as session:
                existing = session.scalar(select(Equipment).where(Equipment.inventory_number == serial))
            save_equipment(serial, "", "", 0, "available", existing.id if existing else None,
                           None, ids[sku], location,
                           96 if sku == "TEST-BAT-V150" else None,
                           100 if sku == "TEST-BAT-V150" else None)
    save_dependency(ids["TEST-CAM-ALEXA"], ids["TEST-BAT-V150"], 2, False)
    save_dependency(ids["TEST-CAM-ALEXA"], ids["TEST-TRIPOD-18"], 1, False)
    print(f"Seeded {len(ARTICLES)} articles and {sum(map(len, ASSETS.values()))} assets")


if __name__ == "__main__":
    main()
