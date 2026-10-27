"""Record support resolution time for PII retention."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_24'
down_revision = '20261027_23'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if 'resolved_at' not in {c['name'] for c in sa.inspect(bind).get_columns('support_threads')}:
        op.add_column('support_threads', sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE support_threads SET resolved_at=created_at WHERE status='resolved' AND resolved_at IS NULL")


def downgrade():
    op.drop_column('support_threads','resolved_at')
