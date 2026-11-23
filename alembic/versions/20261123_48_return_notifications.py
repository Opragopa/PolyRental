"""Deduplicate return notifications for the same booking and planned deadline."""
from alembic import op

revision = "20261123_48"
down_revision = "20261113_47"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS return_due_at TIMESTAMPTZ")
    op.execute("""CREATE UNIQUE INDEX IF NOT EXISTS notification_return_due_unique
        ON notification_deliveries (booking_id, recipient_id, event, return_due_at)
        WHERE return_due_at IS NOT NULL""")


def downgrade():
    op.execute("DROP INDEX IF EXISTS notification_return_due_unique")
    op.execute("ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS return_due_at")
