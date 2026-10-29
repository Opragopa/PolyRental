from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace

import pytest
from pypdf import PdfReader

from app import receipt_pdf
from app.rental import Conflict


def test_receipt_pdf_contains_cyrillic_and_two_staff_signature_points(monkeypatch):
    item = SimpleNamespace(name="Камера Sony", article=None, inventory_number="CAM-001")
    booking = SimpleNamespace(id=7, human_number="ТС260007", identity_status="verified",
                              starts_at=datetime(2026, 11, 1, 9, tzinfo=timezone.utc),
                              ends_at=datetime(2026, 11, 2, 9, tzinfo=timezone.utc),
                              customer_contact="@synthetic", assets=[SimpleNamespace(equipment=item)])
    identity = {"full_name": "Анна Иванова", "passport_series": "0000", "passport_number": "123456",
                "passport_issued_at": "2020-01-01", "passport_issuer": "ОВД",
                "registration_address": "Тестовая улица", "residential_address": "Тестовая улица"}
    monkeypatch.setattr(receipt_pdf, "get_booking", lambda _: booking)
    monkeypatch.setattr(receipt_pdf, "reveal_identity", lambda *_: identity)
    body = receipt_pdf.render_receipt_pdf(7, 100)
    assert body.startswith(b"%PDF-")
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(body)).pages)
    for expected in ("Сохранная расписка", "ТС260007", "Анна Иванова", "Камера Sony", "CAM-001",
                     "Выдача оборудования", "Возврат и приём оборудования"):
        assert expected in text
    assert text.count("Подпись сотрудника") == 2
    assert "Подпись клиента" not in text


def test_receipt_pdf_rejects_unverified_identity_without_revealing_it(monkeypatch):
    booking = SimpleNamespace(identity_status="required", assets=[object()])
    monkeypatch.setattr(receipt_pdf, "get_booking", lambda _: booking)
    monkeypatch.setattr(receipt_pdf, "reveal_identity", lambda *_: pytest.fail("identity must not be read"))
    with pytest.raises(Conflict):
        receipt_pdf.render_receipt_pdf(7, 100)


def test_receipt_pdf_handles_multiple_pages_and_special_characters(monkeypatch):
    assets = [SimpleNamespace(equipment=SimpleNamespace(name="Свет <Тест> & лампа", article=None,
                                                       inventory_number=f"QA-{index:03d}"))
              for index in range(80)]
    booking = SimpleNamespace(id=7, human_number="ТС260007", identity_status="verified",
                              starts_at=datetime(2026, 11, 1, 9, tzinfo=timezone.utc),
                              ends_at=datetime(2026, 11, 2, 9, tzinfo=timezone.utc),
                              customer_contact="@synthetic", assets=assets)
    monkeypatch.setattr(receipt_pdf, "get_booking", lambda _: booking)
    monkeypatch.setattr(receipt_pdf, "reveal_identity", lambda *_: {"full_name": "Анна Иванова"})
    reader = PdfReader(BytesIO(receipt_pdf.render_receipt_pdf(7, 100)))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) > 1
    assert "Свет <Тест> & лампа" in text
    assert all(f"QA-{index:03d}" in text for index in range(80))
    assert text.count("Подпись сотрудника") == 2


def test_one_asset_with_long_features_can_split_across_pages(monkeypatch):
    booking=SimpleNamespace(id=7,human_number="ТС260007",identity_status="verified",assets=[object()],
        starts_at=datetime(2026,11,5,9,tzinfo=timezone.utc),ends_at=datetime(2026,11,6,9,tzinfo=timezone.utc),customer_contact="@synthetic")
    features=[{"description":f"Особенность {index}: "+"Тестовое описание корпуса. "*35} for index in range(12)]
    body=receipt_pdf.render_receipt_pdf(7,100,booking=booking,identity={"full_name":"Тестовый Получатель"},
        snapshot=[{"id":21,"name":"Тестовая камера","code":"TEST-21","features":features}])
    reader=PdfReader(BytesIO(body));text="\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages)>1 and "Особенность 0:" in text and "Особенность 11:" in text
    assert text.count("Подпись сотрудника")==2
