"""Persist first client entry and non-PII onboarding activity."""
from alembic import op
from app.db import ClientActivity, ClientProfile

revision = "20261027_10"
down_revision = "20261027_09"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    ClientProfile.__table__.create(bind, checkfirst=True)
    ClientActivity.__table__.create(bind, checkfirst=True)
    op.execute("CREATE INDEX IF NOT EXISTS bookings_customer_created_idx ON bookings (customer_id, created_at DESC, id DESC)")


def downgrade():
    op.drop_index("bookings_customer_created_idx", table_name="bookings")
    op.drop_table("client_activity")
    op.drop_table("client_profiles")
