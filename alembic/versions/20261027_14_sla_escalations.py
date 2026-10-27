"""Idempotent SLA escalation events."""
from alembic import op
from app.db import SlaEscalation

revision = '20261027_14'
down_revision = '20261027_13'
branch_labels = None
depends_on = None


def upgrade():
    SlaEscalation.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table('sla_escalations')
