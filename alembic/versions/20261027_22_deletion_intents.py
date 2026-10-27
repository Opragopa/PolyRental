"""Audit deletion proposals and undo independently of the UI timer."""
from alembic import op
from app.db import DeletionIntent
revision = '20261027_22'
down_revision = '20261027_21'
branch_labels = None
depends_on = None


def upgrade():
    DeletionIntent.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table('deletion_intents')
