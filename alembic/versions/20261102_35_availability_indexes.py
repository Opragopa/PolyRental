"""Indexes for availability and paginated staff/customer queues."""
from alembic import op

revision = "20261102_35"
down_revision = "20261101_34"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE INDEX IF NOT EXISTS bookings_availability_interval_idx ON bookings (status, starts_at, ends_at) WHERE deleted_at IS NULL OR deletion_level = 'L2'")
    op.execute("CREATE INDEX IF NOT EXISTS booking_lines_active_article_idx ON booking_lines (article_id, booking_id) WHERE deleted_at IS NULL")
    op.execute("CREATE INDEX IF NOT EXISTS equipment_article_condition_idx ON equipment (article_id, condition)")


def downgrade():
    op.execute("DROP INDEX IF EXISTS equipment_article_condition_idx")
    op.execute("DROP INDEX IF EXISTS booking_lines_active_article_idx")
    op.execute("DROP INDEX IF EXISTS bookings_availability_interval_idx")
