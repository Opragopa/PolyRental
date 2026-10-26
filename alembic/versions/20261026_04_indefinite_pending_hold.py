"""Keep pending bookings reserved until an operator decides."""

from alembic import op
import sqlalchemy as sa


revision = "20261026_04"
down_revision = "20261026_03"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("UPDATE bookings SET hold_expires_at = NULL WHERE status = 'pending'"))


def downgrade():
    # The previous deadlines cannot be reconstructed after they are cleared.
    pass
