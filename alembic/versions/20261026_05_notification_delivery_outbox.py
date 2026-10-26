"""Persist Telegram failures and retry them after a transient outage."""

from alembic import op
import sqlalchemy as sa


revision = "20261026_05"
down_revision = "20261026_04"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("booking_id", sa.Integer(), sa.ForeignKey("bookings.id", ondelete="SET NULL"), nullable=True),
        sa.Column("recipient_id", sa.BigInteger(), nullable=False),
        sa.Column("event", sa.String(length=50), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("notification_deliveries_booking_id_idx", "notification_deliveries", ["booking_id"])
    op.create_index("notification_deliveries_recipient_id_idx", "notification_deliveries", ["recipient_id"])
    op.create_index("notification_deliveries_next_retry_at_idx", "notification_deliveries", ["next_retry_at"])
    op.create_index("notification_deliveries_sent_at_idx", "notification_deliveries", ["sent_at"])


def downgrade():
    op.drop_table("notification_deliveries")
