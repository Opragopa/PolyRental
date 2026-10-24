import io
from pathlib import Path
from zoneinfo import ZoneInfo

from docx import Document
from docxtpl import DocxTemplate

from .service import get_booking

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
TITLES = {"contract": "Договор аренды", "issue": "Акт выдачи", "return": "Акт возврата"}


def ensure_templates():
    TEMPLATE_DIR.mkdir(exist_ok=True)
    for kind, title in TITLES.items():
        path = TEMPLATE_DIR / f"{kind}.docx"
        if path.exists():
            continue
        doc = Document()
        doc.add_heading(title, 0)
        doc.add_paragraph("№ {{ booking_id }} от {{ created_at }}")
        doc.add_paragraph("Клиент: {{ customer_name }}; контакт: {{ customer_contact }}")
        doc.add_paragraph("Аренда: {{ starts_at }} — {{ ends_at }} (Москва)")
        doc.add_paragraph("Оборудование: {{ equipment }}")
        doc.add_paragraph("Стоимость аренды: {{ total }} руб.")
        doc.add_paragraph("Подпись клиента: __________  Подпись менеджера: __________")
        doc.save(path)


def render_document(booking_id, kind):
    if kind not in TITLES:
        raise ValueError("Неизвестный документ")
    ensure_templates()
    booking = get_booking(booking_id)
    if booking is None:
        raise ValueError("Заявка не найдена")
    local = ZoneInfo("Europe/Moscow")
    hours = (booking.ends_at - booking.starts_at).total_seconds() / 3600
    total = sum(float(item.hourly_rate) * hours for item in booking.items)
    context = {
        "booking_id": booking.id,
        "created_at": booking.created_at.astimezone(local).strftime("%d.%m.%Y"),
        "customer_name": booking.customer_name,
        "customer_contact": booking.customer_contact,
        "starts_at": booking.starts_at.astimezone(local).strftime("%d.%m.%Y %H:%M"),
        "ends_at": booking.ends_at.astimezone(local).strftime("%d.%m.%Y %H:%M"),
        "equipment": ", ".join(f"{item.equipment.name} ({item.equipment.inventory_number})" for item in booking.items),
        "total": f"{total:.2f}",
    }
    template = DocxTemplate(TEMPLATE_DIR / f"{kind}.docx")
    template.render(context)
    output = io.BytesIO()
    template.save(output)
    return output.getvalue()
