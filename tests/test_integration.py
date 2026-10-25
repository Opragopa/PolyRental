from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import io

import pytest
from docx import Document

from app.db import Article, Booking, Inspection, RepairTicket, Session
from app.documents import render_document
from app.service import (Conflict, assign_booking_assets, availability, create_booking,
                         get_booking, mark_act_signed, now, record_inspection,
                         save_dependency, save_equipment, transition)


def article_with_assets(prefix, count, rate="100", category=None, health=None, charge=None):
    save_equipment(f"{prefix}-1", prefix, "", rate, "available",
                   health_percent=health, charge_percent=charge)
    start = now() + timedelta(hours=2)
    article_id = next(item["id"] for item in availability(start, start + timedelta(hours=1))
                      if item["name"] == prefix)
    if category:
        with Session.begin() as session:
            session.get(Article, article_id).category = category
    for index in range(2, count + 1):
        save_equipment(f"{prefix}-{index}", "", "", 0, "available", article_id=article_id,
                       storage_location=f"A-{index:02}", health_percent=health, charge_percent=charge)
    return article_id


def test_quantity_booking_concurrency_and_buffer():
    article_id = article_with_assets("CAM", 2)
    start, end = now() + timedelta(hours=4), now() + timedelta(hours=6)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create_booking, customer, f"Клиент {customer}", "@test",
                               start, end, [{"article_id": article_id, "quantity": 2}])
                   for customer in (1, 2)]
        outcomes = []
        for future in futures:
            try:
                outcomes.append(future.result())
            except Conflict:
                outcomes.append("conflict")
    assert sum(isinstance(value, int) for value in outcomes) == 1
    assert outcomes.count("conflict") == 1
    assert availability(start, end)[0]["available_quantity"] == 0
    assert availability(end + timedelta(hours=23), end + timedelta(hours=25))[0]["available_quantity"] == 0
    assert availability(end + timedelta(hours=24), end + timedelta(hours=25))[0]["available_quantity"] == 2


def test_dependencies_assignment_checks_and_return_repair():
    camera_id = article_with_assets("CAMERA", 1)
    cable_id = article_with_assets("CABLE", 1, "20")
    save_dependency(camera_id, cable_id, quantity=1, billable=False)
    start, end = now() + timedelta(hours=3), now() + timedelta(hours=5)
    booking_id = create_booking(7, "Анна", "+70000000000", start, end,
                                    [{"article_id": camera_id, "quantity": 1}, {"article_id": cable_id, "quantity": 1}], expected_total="240.00")
    booking = get_booking(booking_id)
    assert len(booking.lines) == 2
    assert next(line for line in booking.lines if line.article_id == cable_id).hourly_rate == 20
    assert transition(booking_id, "confirmed", 10) == "confirmed"
    with pytest.raises(Conflict, match="заполнить документы"):
        assign_booking_assets(booking_id, 10)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    assert assign_booking_assets(booking_id, 10) == "preparing"
    booking = get_booking(booking_id)
    assert len(booking.assets) == 2
    with pytest.raises(Conflict):
        transition(booking_id, "ready", 10)
    for asset in booking.assets:
        record_inspection(booking_id, asset.equipment_id, "pre_issue", "pass", {}, "", 10)
    assert transition(booking_id, "ready", 10) == "ready"
    with pytest.raises(Conflict):
        transition(booking_id, "issued", 10)
    with Session.begin() as session:
        session.get(Booking, booking_id).identity_status = "verified"
    mark_act_signed(booking_id, 99)
    assert transition(booking_id, "issued", 10) == "issued"
    assert transition(booking_id, "return_inspection", 10) == "return_inspection"
    booking = get_booking(booking_id)
    for index, asset in enumerate(booking.assets):
        record_inspection(booking_id, asset.equipment_id, "check_in",
                          "fail" if index == 0 else "pass", {"visual": index != 0}, "", 10,
                          defect="Повреждён разъём", estimated_cost=500, charge_customer=True)
    assert transition(booking_id, "returned", 10) == "returned"
    returned_at = get_booking(booking_id).returned_at
    article_id = cable_id
    still_buffered = availability(returned_at + timedelta(hours=1), returned_at + timedelta(hours=2))
    available_after_buffer = availability(returned_at + timedelta(hours=25), returned_at + timedelta(hours=26))
    assert next(item for item in still_buffered if item["id"] == article_id)["available_quantity"] == 0
    assert next(item for item in available_after_buffer if item["id"] == article_id)["available_quantity"] > 0
    with Session() as session:
        saved = session.query(Inspection).filter_by(booking_id=booking_id, equipment_id=booking.assets[0].equipment_id, stage="check_in").one()
        assert saved.defect == "Повреждён разъём" and saved.estimated_cost == 500 and saved.charge_customer is True
        assert session.query(RepairTicket).filter_by(booking_id=booking_id, equipment_id=booking.assets[0].equipment_id).count() == 1
    contract_text = "\n".join(paragraph.text for paragraph in Document(io.BytesIO(
        render_document(booking_id, "contract"))).paragraphs)
    issue_text = "\n".join(paragraph.text for paragraph in Document(io.BytesIO(
        render_document(booking_id, "issue"))).paragraphs)
    return_text = "\n".join(paragraph.text for paragraph in Document(io.BytesIO(
        render_document(booking_id, "return"))).paragraphs)
    assert "серийный №" not in contract_text
    assert "CAMERA-1" in issue_text
    assert "дефект/ремонт" in return_text


def test_each_selected_item_is_booked_separately():
    camera_id = article_with_assets("CAMERA-PRICE", 1, "3500")
    battery_id = article_with_assets("BAT-PRICE", 3, "350")
    save_dependency(camera_id, battery_id, quantity=2, billable=False)
    start, end = now() + timedelta(hours=3), now() + timedelta(hours=7)
    camera_only = create_booking(31, "Клиент", "@client", start, end,
                                 [{"article_id": camera_id, "quantity": 1}], expected_total="14000.00")
    assert len(get_booking(camera_only).lines) == 1
    camera_and_battery = create_booking(32, "Клиент", "@client", start + timedelta(days=2),
                                        end + timedelta(days=2),
                                        [{"article_id": camera_id, "quantity": 1},
                                         {"article_id": battery_id, "quantity": 1}],
                                        expected_total="15400.00")
    battery_line = next(line for line in get_booking(camera_and_battery).lines
                        if line.article_id == battery_id)
    assert battery_line.quantity == 1 and battery_line.billable_quantity == 1


def test_low_battery_cannot_be_assigned():
    article_id = article_with_assets("BAT", 1, category="battery", health=79, charge=100)
    start, end = now() + timedelta(hours=3), now() + timedelta(hours=4)
    booking_id = create_booking(1, "Клиент", "@client", start, end,
                                [{"article_id": article_id, "quantity": 1}])
    transition(booking_id, "confirmed", 10)
    with pytest.raises(Conflict):
        assign_booking_assets(booking_id, 10)
