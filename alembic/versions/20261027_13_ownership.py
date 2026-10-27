"""Persistent request ownership independent of temporary stage locks."""
from alembic import op
import sqlalchemy as sa

revision = "20261027_13"
down_revision = "20261027_12"
branch_labels = None
depends_on = None


def upgrade():
    columns = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('bookings')}
    for name, data_type in [('assignee_id', sa.BigInteger()), ('claimed_at', sa.DateTime(timezone=True)), ('sla_closed_at', sa.DateTime(timezone=True))]:
        if name not in columns:
            op.add_column('bookings', sa.Column(name, data_type, nullable=True))
    op.execute('CREATE INDEX IF NOT EXISTS ix_bookings_assignee_id ON bookings (assignee_id)')


def downgrade():
    op.drop_index('ix_bookings_assignee_id', table_name='bookings')
    for name in ('sla_closed_at', 'claimed_at', 'assignee_id'):
        op.drop_column('bookings', name)
