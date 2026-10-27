"""Encrypted support threads with explicit ownership."""
from alembic import op
from app.db import SupportThread, SupportMessage, SupportActivity
revision = '20261027_16'
down_revision = '20261027_15'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    for table in (SupportThread.__table__, SupportMessage.__table__, SupportActivity.__table__):
        table.create(bind, checkfirst=True)


def downgrade():
    for table in ('support_activity', 'support_messages', 'support_threads'):
        op.drop_table(table)
