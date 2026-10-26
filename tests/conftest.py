import os

import pytest
from sqlalchemy import delete

# Test-only default; deployment still fails fast without ADMIN_IDS.
os.environ.setdefault("ADMIN_IDS", "100")

from app.db import (Article, ArticleDependency, Audit, Booking, BookingAsset, BookingDeletionAudit, BookingItem,
                    BookingLine, CustomerIdentity, Equipment, IdentityDocument, Inspection,
                    NotificationDelivery, Occupancy, PIIAudit, PrivacyConsent, RepairTicket, Session, init_db)


@pytest.fixture(autouse=True)
def clean_database():
    assert os.getenv("DATABASE_URL", "").split("/")[-1] == "polyrental_test", "Тесты разрешены только на отдельной БД polyrental_test"
    from app.miniapp import _PII_REQUESTS
    _PII_REQUESTS.clear()
    init_db()
    with Session.begin() as session:
        for model in (NotificationDelivery, BookingDeletionAudit, PIIAudit, PrivacyConsent, IdentityDocument, CustomerIdentity,
                      RepairTicket, Inspection, BookingAsset, BookingLine, Audit,
                      Occupancy, BookingItem, Booking, ArticleDependency, Equipment, Article):
            session.execute(delete(model))
    yield
