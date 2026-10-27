"""Track receipt expiry separately from encrypted document bytes."""
from alembic import op
import sqlalchemy as sa

revision = "20261028_29"
down_revision = "20261028_28"
branch_labels = None
depends_on = None


def upgrade():
    if "receipt_archive" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "receipt_archive",
            sa.Column("booking_id", sa.Integer(), sa.ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expired_at", sa.DateTime(timezone=True), nullable=True),
        )
    op.execute("CREATE INDEX IF NOT EXISTS ix_receipt_archive_expires_at ON receipt_archive (expires_at)")


def downgrade():
    op.drop_index("ix_receipt_archive_expires_at", table_name="receipt_archive")
    op.drop_table("receipt_archive")
