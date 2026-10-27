"""Retain removed assigned assets and their inspection links."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_21'
down_revision = '20261027_20'
branch_labels = None
depends_on = None


def upgrade():
    columns = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('booking_assets')}
    if 'deleted_at' not in columns:
        op.add_column('booking_assets', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))
    if 'removed_billable' not in columns:
        op.add_column('booking_assets', sa.Column('removed_billable', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column('booking_assets','removed_billable')
    op.drop_column('booking_assets','deleted_at')
