"""Adapt the supplied receipt template without changing the original file."""

import re
import sys
from pathlib import Path

from docx import Document


TOKEN_MAP = {
    "ДАТА ПЕЧАТИ": "date",
    "ВРЕМЯ ПЕЧАТИ": "time",
    "ИНДИВИДУАЛЬНЫЙ НОМЕР": "receipt_number",
    "ФИО": "full_name",
    "ДОКУМЕНТ": "identity_document",
    "СЕРИЯ И НОМЕР": "passport_number",
    "ВЫДАН": "passport_issued_at",
    "АДРЕС ПРОЖИВАНИЯ": "residential_address",
    "ТЕЛЕФОН": "phone",
    "АДРЕС ЭЛЕКТРОННОЙ ПОЧТЫ": "email",
    "Наименование материальных ценностей": "equipment_name",
    "Комплектация": "equipment_configuration",
    "Инвентарный номер": "serial_number",
    "Количество по умолчанию": "quantity",
    "ФОТО СТУДЕНЧЕСКОГО БИЛЕТА": "documents_note",
    "ФОТО ПАСПОРТА": "documents_note",
}


def cell_paragraphs(cell):
    for paragraph in cell.paragraphs:
        yield paragraph
    for table in cell.tables:
        for row in table.rows:
            for nested_cell in row.cells:
                yield from cell_paragraphs(nested_cell)


def paragraphs(document):
    for paragraph in document.paragraphs:
        yield paragraph
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from cell_paragraphs(cell)
    for section in document.sections:
        yield from section.header.paragraphs
        yield from section.footer.paragraphs


def adapt(source: Path, target: Path):
    document = Document(source)
    for paragraph in paragraphs(document):
        original = paragraph.text
        value = original
        # Организация и её контакты — часть предоставленного пользователем шаблона.
        # Меняется только конкретный подписант, чтобы документ заполнялся сотрудником,
        # который фактически выдаёт оборудование.
        value = value.replace("Власовым Виталием Андреевичем", "сотрудником {{ issuer_name }}")
        value = value.replace("Приложении №1", "приложении №1")
        value = value.replace("приложении №2", "приложении №2")
        for source_token, target_token in TOKEN_MAP.items():
            value = value.replace("{{" + source_token + "}}", "{{ " + target_token + " }}")
        value = re.sub(r"\{\{\s*([^{}]+?)\s*\}\}", lambda match: "{{ " + match.group(1).strip() + " }}", value)
        value = value.replace("{{ identity_document }} {{ passport_number }}", "{{ identity_document }}")
        value = value.replace("моб. тел.: +{{ phone }}", "Контакт: {{ phone }}")
        if "материально-ответственным" in value or "полную материальную ответственность" in value:
            value = ("Я принимаю оборудование без взимания платы на согласованный срок и несу полную материальную "
                     "ответственность за его сохранность. При утрате, повреждении или невозврате обязуюсь возместить "
                     "оператору документально подтверждённую стоимость восстановления либо рыночную стоимость замены "
                     "на дату составления дефектовочной ведомости.")
        if value != original:
            paragraph.text = value
    document.save(target)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: adapt_receipt_template.py SOURCE TARGET")
    adapt(Path(sys.argv[1]), Path(sys.argv[2]))
