"""Persist Telegram failures and retry them after a transient outage."""

from alembic import op
import sqlalchemy as sa


revision = "20261026_05"
down_revision = "20261026_04"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "notification_deliveries" not in inspector.get_table_names():
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
    indexes = {index["name"] for index in inspector.get_indexes("notification_deliveries")}
    for name, columns in (
        ("notification_deliveries_booking_id_idx", ["booking_id"]),
        ("notification_deliveries_recipient_id_idx", ["recipient_id"]),
        ("notification_deliveries_next_retry_at_idx", ["next_retry_at"]),
        ("notification_deliveries_sent_at_idx", ["sent_at"]),
    ):
        if name not in indexes:
            op.create_index(name, "notification_deliveries", columns)


def downgrade():
    op.drop_table("notification_deliveries")
