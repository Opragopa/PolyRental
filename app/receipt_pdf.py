"""Generate the printable receipt in memory; callers must enforce access rights."""
from datetime import timezone
from html import escape
from io import BytesIO
import os
from threading import Lock
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .pii import reveal_identity
from .rental import Conflict, get_booking

_FONT = "PolyRentalDejaVu"
_FONT_LOCK = Lock()


def _font():
    with _FONT_LOCK:
        if _FONT not in pdfmetrics.getRegisteredFontNames():
            path = os.getenv("RECEIPT_FONT_PATH", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
            if not os.path.isfile(path):
                raise Conflict("Шрифт для расписки не настроен")
            pdfmetrics.registerFont(TTFont(_FONT, path))
    return _FONT


def render_receipt_pdf(booking_id, actor_id):
    """Build a PDF from a verified identity and assigned equipment, without disk writes.

    This is a rendering primitive; authorization and durable archival are the
    caller's responsibility. It deliberately does not change the legacy archive.
    """
    booking = get_booking(booking_id)
    if not booking:
        raise ValueError("Заявка не найдена")
    if booking.identity_status != "verified" or not booking.assets:
        raise Conflict("Нужны проверенная анкета и назначенные экземпляры")
    identity = reveal_identity(booking_id, actor_id)
    font = _font()
    body = ParagraphStyle("receipt-body", fontName=font, fontSize=9, leading=13, spaceAfter=6)
    heading = ParagraphStyle("receipt-heading", parent=body, fontSize=14, leading=19, alignment=TA_CENTER, spaceAfter=12)
    cell = ParagraphStyle("receipt-cell", parent=body, fontSize=8, leading=11, spaceAfter=0)
    def p(value, style=body):
        return Paragraph(escape(str(value or "")).replace("\n", "<br/>"), style)
    def fmt(value):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
    output = BytesIO()
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm,
                                 topMargin=15*mm, bottomMargin=15*mm,
                                 title="Сохранная расписка", author="Полимер")
    rows = [[p("Оборудование", cell), p("Инвентарный номер", cell)]]
    for asset in booking.assets:
        item = asset.equipment
        name = item.article.name if item.article else item.name
        rows.append([p(name, cell), p(item.inventory_number, cell)])
    table = Table(rows, colWidths=[105*mm, 65*mm], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), .4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    content = [
        p("Сохранная расписка", heading),
        p(f"Номер заявки: {booking.human_number or booking.id}"),
        p(f"Период аренды (МСК): {fmt(booking.starts_at)} — {fmt(booking.ends_at)}"),
        p(f"Получатель и возвращающий: {identity.get('full_name', '')}"),
        p(f"Паспорт: {identity.get('passport_series', '')} {identity.get('passport_number', '')}; "
          f"дата выдачи: {identity.get('passport_issued_at', '')}; {identity.get('passport_issuer', '')}"),
        p(f"Адрес регистрации: {identity.get('registration_address', '')}"),
        p(f"Адрес проживания: {identity.get('residential_address', '')}"),
        p(f"Контакт: {booking.customer_contact}"),
        p("Передаваемое оборудование:"), table, Spacer(1, 12*mm),
        p("Выдача оборудования"),
        p("Дата и время: __________________  Доверенный сотрудник (ФИО): __________________"),
        p("Подпись сотрудника: __________________"), Spacer(1, 10*mm),
        p("Возврат и приём оборудования"),
        p("Дата и время: __________________  Доверенный сотрудник (ФИО): __________________"),
        p("Подпись сотрудника: __________________"),
    ]
    document.build(content)
    return output.getvalue()
