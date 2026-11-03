"""Extract the actual text and tables of a DOCX receipt for an in-app preview."""
from io import BytesIO
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def receipt_docx_preview(body):
    document = Document(BytesIO(body))
    blocks = []
    for element in document.element.body:
        if element.tag == qn("w:p"):
            paragraph = Paragraph(element, document)
            blocks.append({"type": "paragraph", "text": paragraph.text})
        elif element.tag == qn("w:tbl"):
            table = Table(element, document)
            blocks.append({"type": "table", "rows": [[cell.text for cell in row.cells] for row in table.rows]})
    return {"blocks": blocks}
