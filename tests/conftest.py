import os

import pytest
from sqlalchemy import delete

# Test-only default; deployment still fails fast without ADMIN_IDS.
os.environ.setdefault("ADMIN_IDS", "100")

from app.db import (Article, ArticleTitleAudit, BookingCart, ClientActivity, ClientProfile, SupportActivity, SupportMessage, SupportThread, SlaEscalation, PurgeLog, OperatorNotificationPreference, ArticleDependency, Audit, Booking, BookingAsset, BookingDeletionAudit, BookingItem,
                    BookingLine, CustomerIdentity, Equipment, IdentityDocument, Inspection,
                    NotificationDelivery, Occupancy, PIIAudit, PrivacyConsent, RepairTicket, Session, init_db)


@pytest.fixture(autouse=True)
def clean_database(monkeypatch):
    # Legacy cases use arbitrary periods; strict calendar behavior is exercised
    # separately and in the new end-to-end handover cases.
    monkeypatch.setenv("ENFORCE_HANDOVER_SCHEDULE", "false")
    monkeypatch.setenv("ADMIN_IDS", "100,200")
    assert os.getenv("DATABASE_URL", "").split("/")[-1] == "polyrental_test", "Тесты разрешены только на отдельной БД polyrental_test"
    from app.miniapp import _PII_REQUESTS
    _PII_REQUESTS.clear()
    init_db()
    from app.db import StaffRole, TrustedSigner, CatalogCategory, ReleasePublication, CustomerChangeRequest
    with Session.begin() as session:
        session.execute(delete(TrustedSigner))
        session.execute(delete(ReleasePublication))
        for user_id, role in ((100, "admin"), (200, "manager")):
            row = session.get(StaffRole, user_id)
            if row is None:
                session.add(StaffRole(telegram_id=user_id, role=role))
            else:
                row.role = role
    with Session.begin() as session:
        for model in (CustomerChangeRequest, OperatorNotificationPreference, PurgeLog, SupportActivity, SupportMessage, SupportThread, SlaEscalation, BookingCart, ClientActivity, ClientProfile, ArticleTitleAudit, NotificationDelivery, BookingDeletionAudit, PIIAudit, PrivacyConsent, IdentityDocument, CustomerIdentity,
                      RepairTicket, Inspection, BookingAsset, BookingLine, Audit,
                      Occupancy, BookingItem, Booking, ArticleDependency, Equipment, Article):
            session.execute(delete(model))
        session.execute(delete(CatalogCategory).where(CatalogCategory.code.like("custom_%")))
    yield
