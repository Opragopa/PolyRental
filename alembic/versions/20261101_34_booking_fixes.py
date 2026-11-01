"""Transactional booking events, Telegram cards, seen notices and custom categories."""
from alembic import op
import sqlalchemy as sa

revision = "20261101_34"
down_revision = "20261030_33"
branch_labels = None
depends_on = None


def upgrade():
    from app.db import CatalogCategory, BookingEvent, BookingEventRecipient, BookingBotCard
    from app.catalog_categories import seed_categories
    bind = op.get_bind()
    for model in (CatalogCategory, BookingEvent, BookingEventRecipient, BookingBotCard):
        model.__table__.create(bind, checkfirst=True)
    columns = {column["name"] for column in sa.inspect(bind).get_columns("notification_deliveries")}
    if "event_id" not in columns:
        op.add_column("notification_deliveries", sa.Column("event_id", sa.String(32), nullable=True))
        op.add_column("notification_deliveries", sa.Column("delivery_kind", sa.String(16), nullable=True))
        op.create_foreign_key("notification_booking_event_fk", "notification_deliveries", "booking_events", ["event_id"], ["id"], ondelete="CASCADE")
        op.create_unique_constraint("notification_event_recipient_kind_unique", "notification_deliveries", ["event_id", "recipient_id", "delivery_kind"])
    seed_categories(bind)
    # Events start at this release: historical audit records produce no toasts.
    op.execute("UPDATE notification_deliveries SET cancelled_at = now() WHERE sent_at IS NULL AND cancelled_at IS NULL AND event_id IS NULL AND (event LIKE 'status_%' OR event IN ('booking_created_customer', 'booking_completed_operator', 'identity_submitted', 'identity_rework'))")


def downgrade():
    # Keep delivery IDs, seen markers and category assignments for a forward fix.
    pass
