from datetime import date, datetime, timezone
import io
import hashlib
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from docx import Document
from docx.shared import Mm
from docxtpl import DocxTemplate
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .db import Booking, BookingDocument, Inspection, PIIAudit, Session
from .pii import _master_key, reveal_identity
from .rental import Conflict, get_booking

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
RECEIPT_TEMPLATE = Path(__file__).resolve().parent / "assets" / "receipt-template.docx"
TITLES = {"contract": "Договор аренды", "issue": "Акт выдачи", "return": "Акт возврата", "receipt": "Сохранная расписка"}


def _russian_date(value):
    try:
        return date.fromisoformat(str(value)).strftime("%d.%m.%Y")
    except (TypeError, ValueError):
        return value


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
        with Session.begin() as session:
            row = session.scalar(select(Booking).where(Booking.id == booking.id).with_for_update())
            if row is None:
                raise ValueError("Заявка не найдена")
            if not row.receipt_number:
                # Booking IDs are global, monotonic and never reused; padding
                # keeps common IDs in the requested six-digit YYNNNN format.
                row.receipt_number = f"ТС-{receipt_moment.year % 100:02d}{row.id:04d}"
            receipt_number = row.receipt_number
        grouped_assets = {}
        for line in booking.lines:
            assets = [assignment.equipment for assignment in line.assets]
            grouped_assets[line.id] = (line.article.name, line.article.composition or "", assets)
        # Legacy bookings may have concrete assignments without booking lines.
        if not grouped_assets:
            for asset in booking.assets:
                article = asset.equipment.article
                key = article.id if article else asset.equipment.name
                grouped_assets.setdefault(key, (article.name if article else asset.equipment.name,
                                                article.composition if article else "", []))[2].append(asset.equipment)
        item_rows = list(grouped_assets.values())
        damaged_photos = []
        with Session() as session:
            inspection_rows = session.scalars(select(Inspection).where(
                Inspection.booking_id == booking.id, Inspection.stage == "check_in",
                Inspection.result == "fail", Inspection.encrypted_photo.is_not(None))).all()
            for inspection in inspection_rows:
                aad = f"{booking.id}:{inspection.equipment_id}:damage-photo-v1".encode()
                photo = AESGCM(_master_key()).decrypt(inspection.photo_nonce, inspection.encrypted_photo, aad)
                asset = next((row.equipment for row in booking.assets if row.equipment_id == inspection.equipment_id), None)
                damaged_photos.append((asset.inventory_number if asset else str(inspection.equipment_id), photo))
        context.update({
            "date": receipt_moment.strftime("%d.%m.%Y"),
            "time": receipt_moment.strftime("%H:%M"),
            "receipt_number": receipt_number.removeprefix("ТС-"),
            "issuer_name": os.getenv("OPERATOR_NAME", "сотрудником организации"),
            "identity_document": f"паспорт {identity_payload.get('passport_series', '')} {identity_payload.get('passport_number', '')}",
            "passport_issued_at": _russian_date(identity_payload.get("passport_issued_at", "")),
            "residential_address": identity_payload.get("residential_address", ""),
            "full_name": identity_payload["full_name"],
            "phone": booking.customer_contact,
            "email": "",
            "equipment_name": "\n".join(name for name, _, _ in item_rows),
            "equipment_configuration": "\n".join(composition for _, composition, _ in item_rows),
            "serial_number": "\n".join("\n".join(asset.inventory_number for asset in assets) for _, _, assets in item_rows),
            "quantity": "\n".join(str(len(assets)) for _, _, assets in item_rows),
        })
    template = DocxTemplate(template_path if kind == "receipt" else TEMPLATE_DIR / f"{kind}.docx")
    # Older default templates are upgraded in memory; user-edited files remain untouched.
    if kind != "receipt" and include_identity and not any("{{ identity" in paragraph.text for paragraph in template.get_docx().paragraphs):
        template.get_docx().add_paragraph("Паспортные данные: {{ identity }}")
    template.render(context)
    output = io.BytesIO()
    template.save(output)
    body = output.getvalue()
    if kind == "receipt" and damaged_photos:
        document = Document(io.BytesIO(body))
        document.add_page_break()
        document.add_heading("Приложение к сохранной расписке. Повреждения", level=1)
        document.add_paragraph(f"Расписка № ТС-{receipt_number}")
        for serial, photo in damaged_photos:
            document.add_heading(f"Экземпляр {serial}", level=2)
            document.add_picture(io.BytesIO(photo), width=Mm(150))
        output = io.BytesIO()
        document.save(output)
        body = output.getvalue()
    return body


def _decrypt_archived_document(document):
    aad = f"{document.booking_id}:{document.kind}:doc-v1".encode()
    return AESGCM(_master_key()).decrypt(document.nonce, document.encrypted_data, aad)


def archived_document(booking_id, kind, actor_id, refresh=False):
    """Return an archived DOCX, creating the durable archive on first access."""
    if kind not in {"issue", "receipt"}:
        raise ValueError("Неизвестный документ")
    with Session() as session:
        saved = session.get(BookingDocument, (booking_id, kind))
        if saved is not None and not refresh:
            body = _decrypt_archived_document(saved)
            with Session.begin() as audit_session:
                audit_session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id,
                                           action="document_downloaded"))
            return body, saved.filename

    body = render_document(booking_id, kind, include_identity=True, actor_id=actor_id)
    filename = f"{'act' if kind == 'issue' else 'receipt'}-{booking_id}.docx"
    nonce = os.urandom(12)
    aad = f"{booking_id}:{kind}:doc-v1".encode()
    encrypted = AESGCM(_master_key()).encrypt(nonce, body, aad)
    try:
        with Session.begin() as session:
            saved = session.get(BookingDocument, (booking_id, kind), with_for_update=True)
            if saved is None:
                saved = BookingDocument(booking_id=booking_id, kind=kind, filename=filename)
            saved.media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            saved.encrypted_data, saved.nonce = encrypted, nonce
            saved.sha256 = hashlib.sha256(body).hexdigest()
            session.add(saved)
            session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id,
                                 action="document_replaced" if refresh else "document_archived"))
    except IntegrityError:
        # A simultaneous request may have won the unique booking/kind insert.
        pass
    with Session() as session:
        saved = session.get(BookingDocument, (booking_id, kind))
        if saved is None:
            raise ValueError("Документ не удалось сохранить в архив")
        return _decrypt_archived_document(saved), saved.filename


def operator_document(booking_id, kind, actor_id):
    """Preview before signature; otherwise return the durable archived copy."""
    booking = get_booking(booking_id)
    if booking is None:
        raise ValueError("Заявка не найдена")
    if booking.status in {"confirmed", "preparing"} or (booking.status == "ready" and not booking.act_signed_at):
        return render_document(booking_id, kind, include_identity=True, actor_id=actor_id), \
            f"{'act' if kind == 'issue' else kind}-{booking_id}.docx"
    if kind == "receipt":
        with Session() as session:
            damaged_photo = session.scalar(select(Inspection.id).where(
                Inspection.booking_id == booking_id, Inspection.stage == "check_in",
                Inspection.result == "fail", Inspection.encrypted_photo.is_not(None)).limit(1))
        if damaged_photo:
            return archived_document(booking_id, kind, actor_id, refresh=True)
    return archived_document(booking_id, kind, actor_id)


def archive_completed_documents():
    """Backfill durable copies before retained identity data is purged."""
    with Session() as session:
        booking_ids = session.scalars(select(Booking.id).where(
            Booking.identity_status == "verified",
            ((Booking.status == "ready") & Booking.act_signed_at.is_not(None)) |
            Booking.status.in_({"issued", "return_inspection", "returned"})
        )).all()
    archived = 0
    for booking_id in booking_ids:
        for kind in ("issue", "receipt"):
            try:
                with Session() as session:
                    exists = session.get(BookingDocument, (booking_id, kind)) is not None
                if not exists:
                    archived_document(booking_id, kind, 0)
                    archived += 1
            except Exception:
                # A missing/rotated key or malformed legacy record must not stop startup.
                continue
    return archived
