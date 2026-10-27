"""Persist a versioned booking cart per verified Telegram ID."""
from alembic import op
from app.db import BookingCart

revision = '20261027_15'
down_revision = '20261027_14'
branch_labels = None
depends_on = None


def upgrade():
    BookingCart.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table('booking_carts')
