import os

import pytest
from sqlalchemy import delete

from app.db import (Article, ArticleDependency, Audit, Booking, BookingAsset, BookingItem,
                    BookingLine, CustomerIdentity, Equipment, IdentityDocument, Inspection,
                    Occupancy, PIIAudit, PrivacyConsent, RepairTicket, Session, init_db)


@pytest.fixture(autouse=True)
def clean_database():
    assert os.getenv("DATABASE_URL", "").split("/")[-1] == "polyrental_test", "Тесты разрешены только на отдельной БД polyrental_test"
    from app.miniapp import _PII_REQUESTS
    _PII_REQUESTS.clear()
    init_db()
    with Session.begin() as session:
        for model in (PIIAudit, PrivacyConsent, IdentityDocument, CustomerIdentity,
                      RepairTicket, Inspection, BookingAsset, BookingLine, Audit,
                      Occupancy, BookingItem, Booking, ArticleDependency, Equipment, Article):
            session.execute(delete(model))
    yield
