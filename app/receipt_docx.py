"""Render the established paper receipt from the locked handover snapshot."""
from datetime import datetime
from zoneinfo import ZoneInfo
import io
import os
from copy import deepcopy
from docxtpl import DocxTemplate
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from .documents import RECEIPT_TEMPLATE, _russian_date

DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _fill_equipment_rows(document, snapshot):
    table = document.tables[1]
    prototype = deepcopy(table.rows[1]._tr)
    table._tbl.remove(table.rows[1]._tr)
    for index, item in enumerate(snapshot, 1):
        table._tbl.append(deepcopy(prototype))
        row = table.rows[-1]
        components = "; ".join(component["name"] + (f" → {component['replacement_name']}" if component.get("replacement_name") else "")
            for component in item.get("components", []) if component.get("state") not in {"missing", "faulty"}) or "—"
        for cell, value in zip(row.cells, (str(index), item["name"], components, item.get("code", ""), "1")):
            cell.text = value
    usable = document.sections[0].page_width - document.sections[0].left_margin - document.sections[0].right_margin
    table.autofit = False
    proportions = (0.04, 0.36, 0.33, 0.21, 0.06)
    for column, proportion in zip(table.columns, proportions):
        column.width = int(usable * proportion)
    for row_index, row in enumerate(table.rows):
        for cell, proportion in zip(row.cells, proportions):
            cell.width = int(usable * proportion)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = Pt(4)
                paragraph.paragraph_format.space_before = Pt(4)
                for run in paragraph.runs:
                    run.font.size = Pt(11)
                    run.font.name = "Times New Roman"
                    run.bold = row_index == 0
    repeat = OxmlElement("w:tblHeader")
    table.rows[0]._tr.get_or_add_trPr().append(repeat)
    # Keep signature rows whole, rather than carrying their last words alone.
    for signature_table in document.tables[2:4]:
        signature_table.autofit = False
        for row in signature_table.rows:
            row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
            for cell, proportion in zip(row.cells, (0.22, 0.28, 0.22, 0.28)):
                cell.width = int(usable * proportion)
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        run.font.size = Pt(11)
    # The legacy template ends with a forced empty page.
    body = document.element.body
    while len(body) > 1 and body[-2].tag == qn("w:p") and not "".join(body[-2].itertext()).strip():
        body.remove(body[-2])
    for paragraph in document.paragraphs:
        if paragraph.text.startswith(("Отметка о ", "Дата и время:")):
            paragraph.paragraph_format.keep_with_next = True
    for section in document.sections:
        for paragraph in section.footer.paragraphs:
            for run in list(paragraph.runs):
                if "из 4" in run.text:
                    before, after = run.text.split("из 4", 1)
                    run.text = before + "из "
                    field = OxmlElement("w:fldSimple")
                    field.set(qn("w:instr"), "NUMPAGES")
                    run._r.addnext(field)
                    tail = OxmlElement("w:r")
                    text = OxmlElement("w:t")
                    text.set(qn("xml:space"), "preserve")
                    text.text = after
                    tail.append(text)
                    field.addnext(tail)


def render_receipt_docx(booking, identity, snapshot, exceptions, *, legacy=False):
    moment = datetime.now(ZoneInfo("Europe/Moscow"))
    template = DocxTemplate(RECEIPT_TEMPLATE)
    # Both occurrences are inside template tables, not top-level paragraphs.
    for node in template.get_docx().element.xpath(".//w:t"):
        if node.text:
            node.text = node.text.replace("ТС-{{ receipt_number }}", "{{ receipt_number }}")
    context = {
        "date": moment.strftime("%d.%m.%Y"), "time": moment.strftime("%H:%M"),
        "receipt_number": booking.human_number or booking.receipt_number or str(booking.id),
        "issuer_name": os.getenv("OPERATOR_NAME", "сотрудником организации"),
        "full_name": identity["full_name"],
        "identity_document": f"паспорт {identity.get('passport_series', '')} {identity.get('passport_number', '')}",
        "passport_issued_at": _russian_date(identity.get("passport_issued_at", "")),
        "residential_address": identity.get("residential_address", ""),
        "phone": booking.customer_contact, "email": "",
        "equipment_name": "\n".join(item["name"] for item in snapshot),
        "equipment_configuration": "\n".join("; ".join(
            component["name"] + (f" → {component['replacement_name']}" if component.get("replacement_name") else "")
            for component in item.get("components", []) if component.get("state") not in {"missing", "faulty"}) or "—" for item in snapshot),
        "serial_number": "\n".join(item.get("code", "") for item in snapshot),
        "quantity": "\n".join("1" for _ in snapshot),
    }
    template.render(context, autoescape=True)
    output = io.BytesIO()
    template.save(output)
    document = Document(io.BytesIO(output.getvalue()))
    _fill_equipment_rows(document, snapshot)
    features = [(item, feature) for item in snapshot for feature in item.get("features", [])]
    if exceptions or features or legacy:
        document.add_page_break()
        heading = document.add_heading("Приложение к сохранной расписке", level=1)
        for run in heading.runs:
            run.font.size, run.font.name, run.font.color.rgb = Pt(14), "Times New Roman", RGBColor(0, 0, 0)
        document.add_paragraph(f"Расписка № {context['receipt_number']}")
        reasons = {"missing": "Не выдано: отсутствует", "faulty": "Не выдано: неисправность", "replacement": "Заменено"}
        for item in exceptions:
            title = item.get("name") or item.get("replacement_title") or f"Экземпляр {item.get('equipment_id', '')}"
            document.add_paragraph(f"{title}{' / ' + item['component'] if item.get('component') else ''}: "
                f"{reasons.get(item.get('reason'), '')} {item.get('replacement_name') or item.get('replacement_title', '')} {item.get('note', '')}".strip())
        for item, feature in features:
            document.add_paragraph(f"{item['name']} ({item.get('code', '')}): {feature['description']}")
        if legacy:
            document.add_paragraph("Перенос старой выдачи: исходный снимок особенностей и комплектации отсутствовал.")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()
