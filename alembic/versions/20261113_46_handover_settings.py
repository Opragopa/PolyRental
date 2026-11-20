"""Separate public pickup instructions from the operator's legal address."""
from alembic import op

revision = "20261113_46"
down_revision = "20261110_45"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE IF NOT EXISTS handover_settings (
      id INTEGER PRIMARY KEY CHECK (id=1), pickup_location VARCHAR(500) NOT NULL DEFAULT '',
      pickup_instructions TEXT NOT NULL DEFAULT '', updated_by BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""")


def downgrade():
    op.execute("DROP TABLE handover_settings")
