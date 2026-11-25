"""Keep the Telegram username separately from the display name."""
from alembic import op

revision = "20261124_49"
down_revision = "20261123_48"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE client_profiles ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(32)")


def downgrade():
    op.execute("ALTER TABLE client_profiles DROP COLUMN IF EXISTS telegram_username")
