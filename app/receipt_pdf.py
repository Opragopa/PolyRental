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
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

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


def render_receipt_pdf(booking_id, actor_id, *, booking=None, identity=None, snapshot=None, exceptions=None, legacy=False):
    """Build a PDF from a verified identity and assigned equipment, without disk writes.

    This is a rendering primitive; authorization and durable archival are the
    caller's responsibility. It deliberately does not change the legacy archive.
    """
    booking = booking or get_booking(booking_id)
    if not booking:
        raise ValueError("Заявка не найдена")
    if booking.identity_status != "verified" or not booking.assets:
        raise Conflict("Нужны проверенная анкета и назначенные экземпляры")
    identity = identity if identity is not None else reveal_identity(booking_id, actor_id)
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
    snapshot = snapshot if snapshot is not None else [{"id": getattr(row, "equipment_id", None),
        "name": row.equipment.article.name if row.equipment.article else row.equipment.name,
        "code": row.equipment.inventory_number, "features": []} for row in booking.assets]
    for item in snapshot:
        features = "\n".join(row["description"] for row in item.get("features", []))
        composition="\n".join("• "+(row.get("replacement_name") or row["name"]) for row in item.get("components",[]) if row["state"] not in {"missing","faulty"})
        name = item["name"] + (f"\nКомплектация:\n{composition}" if composition else "") + (f"\nОсобенности: {features}" if features else "")
        rows.append([p(name, cell), p(item["code"], cell)])
    table = Table(rows, colWidths=[105*mm, 65*mm], repeatRows=1, hAlign="LEFT",splitInRow=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), .4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    content = [
        p("Сохранная расписка", heading),
        p(f"Оператор: {os.getenv('OPERATOR_NAME','Медиацентр Полимер')}"),
        p(f"Номер заявки: {booking.human_number or booking.id}"),
        p(f"Период аренды (МСК): {fmt(booking.starts_at)} — {fmt(booking.ends_at)}"),
        p(f"Получатель и возвращающий: {identity.get('full_name', '')}"),
        p(f"Паспорт: {identity.get('passport_series', '')} {identity.get('passport_number', '')}; "
          f"дата выдачи: {identity.get('passport_issued_at', '')}; {identity.get('passport_issuer', '')}"),
        p(f"Адрес регистрации: {identity.get('registration_address', '')}"),
        p(f"Адрес проживания: {identity.get('residential_address', '')}"),
        p(f"Контакт: {booking.customer_contact}"),
        p("Передаваемое оборудование:"), table, Spacer(1, 5*mm),
        p("Я принимаю оборудование без взимания платы на согласованный срок и несу полную материальную ответственность за его сохранность. При утрате, повреждении или невозврате обязуюсь возместить оператору документально подтверждённую стоимость восстановления либо рыночную стоимость замены на дату составления дефектовочной ведомости."),
        Spacer(1, 5*mm),
        p("Выдача оборудования"),
        p("Подпись получателя (ознакомлен и согласен): __________________"),
        p("Дата и время: __________________  Сотрудник (ФИО): __________________"),
        p("Подпись сотрудника: __________________"), Spacer(1, 10*mm),
        p("Возврат и приём оборудования"),
        p("Подпись возвращающего (получателя): __________________"),
        p("Дата и время: __________________  Сотрудник (ФИО): __________________"),
        p("Подпись сотрудника: __________________"),
    ]
    if exceptions:
        content.extend([PageBreak(), p("Приложение к сохранной расписке", heading),
                        p(f"Заявка: {booking.human_number or booking.id}"), p("Частичная выдача")])
        labels = {"missing": "Отсутствует", "faulty": "Неисправность", "replacement": "Замена"}
        for item in exceptions:
            content.append(p(f"{item['name']}{' / '+item['component'] if item.get('component') else ''}: {labels[item['reason']]} — {item.get('note', '')}" +
                             (f"; выдано взамен: {item['replacement_name']}" if item.get("replacement_name") else "")))
        content.extend([Spacer(1, 10*mm), p("С перечнем ознакомлен. Подпись получателя: __________________")])
    if legacy:
        content.insert(3, p("Историческая выдача. Снимок особенностей при выдаче отсутствовал. Бумажные подписи прошлых этапов в приложении не восстанавливаются."))
    document.build(content)
    return output.getvalue()
