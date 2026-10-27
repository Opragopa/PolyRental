"""Durable expiry for deferred deletion intents."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_26'
down_revision = '20261027_25'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if 'expires_at' not in {c['name'] for c in sa.inspect(bind).get_columns('deletion_intents')}:
        op.add_column('deletion_intents', sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True))
        op.execute("UPDATE deletion_intents SET expires_at=created_at + interval '5 seconds' WHERE expires_at IS NULL")
        op.alter_column('deletion_intents', 'expires_at', nullable=False, server_default=sa.text('now()'))
    op.execute('CREATE INDEX IF NOT EXISTS deletion_intents_expiry_idx ON deletion_intents (expires_at) WHERE status = \'pending\'')


def downgrade():
    op.drop_index('deletion_intents_expiry_idx', table_name='deletion_intents')
    op.drop_column('deletion_intents','expires_at')
