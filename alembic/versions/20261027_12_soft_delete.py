"""Keep soft-deleted requests and their history."""
from alembic import op
import sqlalchemy as sa

revision = "20261027_12"
down_revision = "20261027_11"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "deleted_at" not in {c["name"] for c in sa.inspect(bind).get_columns("bookings")}:
        op.add_column("bookings", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    if "deleted_at" not in {c["name"] for c in sa.inspect(bind).get_columns("booking_lines")}:
        op.add_column("booking_lines", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("CREATE INDEX IF NOT EXISTS ix_bookings_deleted_at ON bookings (deleted_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_booking_lines_deleted_at ON booking_lines (deleted_at)")


def downgrade():
    op.drop_index("ix_bookings_deleted_at", table_name="bookings")
    op.drop_index("ix_booking_lines_deleted_at", table_name="booking_lines")
    op.drop_column("booking_lines", "deleted_at")
    op.drop_column("bookings", "deleted_at")
