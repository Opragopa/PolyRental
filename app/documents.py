from datetime import datetime, timezone
import io
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from docx import Document
from docxtpl import DocxTemplate
from sqlalchemy import select

from .db import Inspection, Session
from .pii import reveal_identity
from .rental import Conflict, get_booking, lines_total

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
RECEIPT_TEMPLATE = Path(__file__).resolve().parent / "assets" / "receipt-template.docx"
TITLES = {"contract": "Договор аренды", "issue": "Акт выдачи", "return": "Акт возврата", "receipt": "Сохранная расписка"}


def ensure_templates():
    TEMPLATE_DIR.mkdir(exist_ok=True)
    for kind, title in TITLES.items():
        if kind == "receipt":
            continue
        path = TEMPLATE_DIR / f"{kind}.docx"
        if path.exists():
            continue
        doc = Document()
        doc.add_heading(title, 0)
        doc.add_paragraph("№ {{ booking_id }} от {{ created_at }}")
        doc.add_paragraph("Клиент: {{ customer_name }}; контакт: {{ customer_contact }}")
        doc.add_paragraph("Аренда: {{ starts_at }} — {{ ends_at }} (Москва)")
        doc.add_paragraph("Оборудование: {{ equipment }}")
        doc.add_paragraph("Паспортные данные: {{ identity }}")
        doc.add_paragraph("Стоимость аренды: {{ total }} руб.")
        doc.add_paragraph("Подпись клиента: __________  Подпись менеджера: __________")
        doc.save(path)


def render_document(booking_id, kind, include_identity=False, actor_id=0):
    if kind not in TITLES:
        raise ValueError("Неизвестный документ")
    ensure_templates()
    booking = get_booking(booking_id)
    if booking is None:
        raise ValueError("Заявка не найдена")
    local = ZoneInfo("Europe/Moscow")
    if kind in {"issue", "return", "receipt"} and not booking.assets:
        raise Conflict("Сначала назначьте конкретные экземпляры")
    if kind == "receipt" and not include_identity:
        raise Conflict("Сохранная расписка содержит реквизиты получателя и доступна только PII_ADMIN_IDS")
    total = lines_total(booking.starts_at, booking.ends_at, booking.lines)
    if kind == "contract":
        equipment = ", ".join(f"{line.article.name} — {line.quantity} шт." for line in booking.lines)
    else:
        equipment = ", ".join(
            f"{asset.equipment.article.name if asset.equipment.article else asset.equipment.name} "
            f"(серийный № {asset.equipment.inventory_number})" for asset in booking.assets
        )
        if kind == "return":
            with Session() as session:
                results = {row.equipment_id: row for row in session.scalars(select(Inspection).where(
                    Inspection.booking_id == booking.id, Inspection.stage == "check_in")).all()}
            equipment = "; ".join(
                f"{asset.equipment.article.name if asset.equipment.article else asset.equipment.name} "
                f"(серийный № {asset.equipment.inventory_number}) — "
                f"{'исправен' if results.get(asset.equipment_id) and results[asset.equipment_id].result == 'pass' else 'дефект/ремонт'}"
                for asset in booking.assets
            )
    identity_text = ""
    identity_payload = {}
    if include_identity:
        if booking.identity_status != "verified":
            raise Conflict("Персональные данные клиента ещё не проверены")
        identity = reveal_identity(booking.id, actor_id)
        identity_payload = identity
        identity_text = (
            f"{identity['full_name']}, дата рождения {identity['birth_date']}; паспорт "
            f"{identity['passport_series']} {identity['passport_number']}, выдан "
            f"{identity['passport_issued_at']} {identity['passport_issuer']}, код "
            f"{identity['passport_division_code']}; регистрация: {identity['registration_address']}; "
            f"проживание: {identity['residential_address']}; студенческий билет "
            f"{identity['student_id_number']}, {identity['student_institution']}"
        )
    context = {
        "booking_id": booking.id,
        "created_at": booking.created_at.astimezone(local).strftime("%d.%m.%Y"),
        "customer_name": booking.customer_name,
        "customer_contact": booking.customer_contact,
        "starts_at": booking.starts_at.astimezone(local).strftime("%d.%m.%Y %H:%M"),
        "ends_at": booking.ends_at.astimezone(local).strftime("%d.%m.%Y %H:%M"),
        "equipment": equipment,
        "identity": identity_text,
        "total": f"{total:.2f}",
    }
    if kind == "receipt":
        template_path = RECEIPT_TEMPLATE
        if not template_path.exists():
            raise ValueError("Шаблон сохранной расписки не найден")
        # Use the recorded act signature when available; otherwise this receipt's
        # issue date is the time it is generated for signing, not booking creation.
        receipt_moment = booking.act_signed_at or datetime.now(local)
        if receipt_moment.tzinfo is None:
            receipt_moment = receipt_moment.replace(tzinfo=timezone.utc)
        receipt_moment = receipt_moment.astimezone(local)
        if not identity_payload.get("full_name"):
            raise Conflict("В проверенной анкете не указано ФИО получателя")
        context.update({
            "date": receipt_moment.strftime("%d.%m.%Y"),
            "time": receipt_moment.strftime("%H:%M"),
            # Booking IDs are monotonically allocated and never reused after deletion.
            # The year makes the human-facing number easier to sort and recognize.
            "receipt_number": f"SR-{booking.created_at.astimezone(local).year}-{booking.id:08d}",
            "issuer_name": os.getenv("OPERATOR_NAME", "сотрудником организации"),
            "identity_document": f"паспорт {identity_payload.get('passport_series', '')} {identity_payload.get('passport_number', '')}",
            "passport_issued_at": identity_payload.get("passport_issued_at", ""),
            "residential_address": identity_payload.get("residential_address", ""),
            "full_name": identity_payload["full_name"],
            "phone": booking.customer_contact,
            "email": "",
            "equipment_name": "\n".join(asset.equipment.article.name if asset.equipment.article else asset.equipment.name for asset in booking.assets),
            "equipment_configuration": "\n".join((asset.equipment.article.sku if asset.equipment.article else asset.equipment.name) for asset in booking.assets),
            "serial_number": "\n".join(asset.equipment.inventory_number for asset in booking.assets),
            "quantity": "\n".join("1" for _ in booking.assets),
            "documents_note": "Документы получателя проверены сотрудником организации и хранятся в защищённом контуре.",
        })
    template = DocxTemplate(template_path if kind == "receipt" else TEMPLATE_DIR / f"{kind}.docx")
    # Older default templates are upgraded in memory; user-edited files remain untouched.
    if kind != "receipt" and include_identity and not any("{{ identity" in paragraph.text for paragraph in template.get_docx().paragraphs):
        template.get_docx().add_paragraph("Паспортные данные: {{ identity }}")
    template.render(context)
    output = io.BytesIO()
    template.save(output)
    return output.getvalue()
