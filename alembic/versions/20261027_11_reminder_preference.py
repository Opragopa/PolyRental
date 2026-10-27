"""Persist preference for non-transactional reminders."""
from alembic import op
import sqlalchemy as sa

revision = "20261027_11"
down_revision = "20261027_10"
branch_labels = None
depends_on = None


def upgrade():
    if "reminders_enabled" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("client_profiles")}:
        op.add_column("client_profiles", sa.Column("reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade():
    op.drop_column("client_profiles", "reminders_enabled")
