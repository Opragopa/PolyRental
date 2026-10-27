"""Keep client booking restrictions separate from identity review status."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_20'
down_revision = '20261027_19'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if 'client_blocked' not in {c['name'] for c in sa.inspect(bind).get_columns('client_profiles')}:
        op.add_column('client_profiles', sa.Column('client_blocked', sa.Boolean(), nullable=False, server_default=sa.false()))
    if 'actor_id' not in {c['name'] for c in sa.inspect(bind).get_columns('client_activity')}:
        op.add_column('client_activity', sa.Column('actor_id', sa.BigInteger(), nullable=True))


def downgrade():
    op.drop_column('client_activity','actor_id')
    op.drop_column('client_profiles','client_blocked')
