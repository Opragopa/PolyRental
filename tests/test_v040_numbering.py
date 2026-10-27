from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
from uuid import uuid4

from sqlalchemy import select
from docx import Document

from app.db import Audit, Booking, RequestNumberCounter, Session
from app.miniapp import booking_view
from app.rental import create_booking, get_booking, now, save_equipment
from app.request_numbers import parse_request_number
from app.documents import render_document
from app.rental import resolve_booking_number


def test_numbers_are_atomic_and_idempotent():
    article_id = save_equipment("NUM-ASSET", "Number test", "", 0, "available")
    # save_equipment returns an equipment ID; resolve the linked article.
    from app.db import Equipment
    with Session() as session:
        article_id = session.get(Equipment, article_id).article_id
    start = now() + timedelta(days=4)
    end = start + timedelta(hours=1)
    requests = [str(uuid4()) for _ in range(8)]

    def create(index):
        # Separate dates avoid availability conflicts while counters contend.
        shift = timedelta(days=2 * index)
        return create_booking(index + 1, "Test", "@test", start + shift, end + shift,
                              [{"article_id": article_id, "quantity": 1}], request_id=requests[index])

    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(create, range(8)))
    numbers = [get_booking(booking_id).human_number for booking_id in ids]
    parsed = [parse_request_number(number) for number in numbers]
    assert len(set(numbers)) == 8
    assert len({year for year, _ in parsed}) == 1
    sequences = sorted(seq for _, seq in parsed)
    assert sequences == list(range(sequences[0], sequences[0] + 8))
    assert create(0) == ids[0]
    assert booking_view(get_booking(ids[0]))["human_number"] == numbers[0]
    assert resolve_booking_number(numbers[0]) == ids[0]
    assert resolve_booking_number(numbers[0][-4:]) == ids[0]
    document = Document(BytesIO(render_document(ids[0], "contract")))
    assert numbers[0] in "\n".join(p.text for p in document.paragraphs)
    with Session() as session:
        assert session.get(RequestNumberCounter, parsed[0][0]).last_sequence == sequences[-1]
        assert session.scalar(select(Audit.id).where(Audit.booking_id == ids[0],
                                                     Audit.action == "number_assigned"))
