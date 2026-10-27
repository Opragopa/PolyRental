"""Keep escalation deduplication independent for later rental stages."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_23'
down_revision = '20261027_22'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if 'sla_cycle' not in {c['name'] for c in sa.inspect(bind).get_columns('bookings')}:
        op.add_column('bookings', sa.Column('sla_cycle', sa.Integer(), nullable=False, server_default='0'))
    if 'cycle' not in {c['name'] for c in sa.inspect(bind).get_columns('sla_escalations')}:
        op.add_column('sla_escalations', sa.Column('cycle', sa.Integer(), nullable=False, server_default='0'))
    pk = sa.inspect(bind).get_pk_constraint('sla_escalations')
    if 'cycle' not in pk['constrained_columns']:
        op.drop_constraint(pk['name'], 'sla_escalations', type_='primary')
        op.create_primary_key('sla_escalations_pkey', 'sla_escalations', ['booking_id','tier','cycle'])


def downgrade():
    op.drop_constraint('sla_escalations_pkey', 'sla_escalations', type_='primary')
    op.execute('DELETE FROM sla_escalations WHERE cycle <> 0')
    op.create_primary_key('sla_escalations_pkey', 'sla_escalations', ['booking_id','tier'])
    op.drop_column('sla_escalations','cycle')
    op.drop_column('bookings','sla_cycle')
