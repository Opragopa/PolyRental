"""Schedule private Telegram copies of new support messages."""
from alembic import op

revision = "20261124_50"
down_revision = "20261124_49"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS operator_copy_at TIMESTAMPTZ")
    op.execute("""CREATE INDEX IF NOT EXISTS support_operator_copy_pending
        ON support_messages (operator_copy_at, id) WHERE operator_copy_at IS NOT NULL""")


def downgrade():
    op.execute("DROP INDEX IF EXISTS support_operator_copy_pending")
    op.execute("ALTER TABLE support_messages DROP COLUMN IF EXISTS operator_copy_at")
