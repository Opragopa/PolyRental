"""Deterministic catalog title composition and conservative local backfill."""
import re

KINDS = {
    "memory_card": "Карта памяти", "storage": "Накопитель", "battery": "Аккумулятор",
    "camera": "Камера", "lens": "Объектив", "tripod": "Штатив",
    "light": "Осветитель", "accessory": "Аксессуар",
}
_CATEGORY_KIND = {"camera": "camera", "optics": "lens", "battery": "battery", "light": "light"}
_RULES = (
    (r"\b(?:sdxc|sdhc|micro\s*sd|cfexpress)\b|карт[аы] памяти", "memory_card"),
    (r"\b(?:ssd|hdd)\b|жестк[ийого]+ диск", "storage"),
    (r"штатив|\btripod\b", "tripod"),
    (r"объектив|\blens\b", "lens"),
    (r"аккумулятор|\bbattery\b", "battery"),
    (r"фотоаппарат|камера|\bcamera\b", "camera"),
)
_BRANDS = ("Lexar", "SanDisk", "Samsung", "Kingston", "Sony", "Canon", "Nikon",
           "Panasonic", "Fujifilm", "Sigma", "Tamron", "Manfrotto", "Seagate", "WD")
_SPEC = {
    "memory_card": r"\b\d+(?:[.,]\d+)?\s*(?:TB|GB|ТБ|ГБ)\b",
    "storage": r"\b\d+(?:[.,]\d+)?\s*(?:TB|GB|ТБ|ГБ)\b",
    "battery": r"\b\d+(?:[.,]\d+)?\s*(?:mAh|Wh|мАч|Втч)\b",
    "lens": r"\b\d+(?:\s*[-–]\s*\d+)?\s*(?:mm|мм)\b",
    "tripod": r"\b\d+(?:[.,]\d+)?\s*(?:cm|см|mm|мм)\b",
}


def infer_structured(name, category="generic"):
    name = name or ""
    kind = next((value for pattern, value in _RULES if re.search(pattern, name, re.I)),
                _CATEGORY_KIND.get(category, ""))
    brand = next((brand for brand in _BRANDS if re.search(r"(?<!\w)" + re.escape(brand) + r"(?!\w)", name, re.I)), "")
    match = re.search(_SPEC.get(kind, r"(?!)"), name, re.I)
    return {"kind": kind, "brand": brand, "key_spec": match.group(0).strip() if match else ""}


def catalog_title(name, kind="", brand="", key_spec=""):
    return (name or "").strip() or "Оборудование"
