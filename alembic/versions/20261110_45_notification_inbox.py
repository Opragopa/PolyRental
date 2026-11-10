"""Persist inbox initialization and per-notification read state."""
from alembic import op

revision = "20261110_45"
down_revision = "20261110_44"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE TABLE notification_inbox_users (recipient_id BIGINT PRIMARY KEY, initialized_at TIMESTAMPTZ NOT NULL DEFAULT now())")
    op.execute("CREATE TABLE notification_inbox_reads (recipient_id BIGINT NOT NULL, notification_key VARCHAR(80) NOT NULL, PRIMARY KEY (recipient_id, notification_key))")


def downgrade():
    op.execute("DROP TABLE notification_inbox_reads")
    op.execute("DROP TABLE notification_inbox_users")
