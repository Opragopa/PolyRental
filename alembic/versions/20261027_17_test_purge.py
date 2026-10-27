"""Test flags and durable non-PII purge log."""
from alembic import op
import sqlalchemy as sa
from app.db import PurgeLog
revision = '20261027_17'
down_revision = '20261027_16'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    for table, name, column in (
        ('articles', 'is_test', sa.Column('is_test', sa.Boolean(), nullable=False, server_default=sa.false())),
        ('bookings', 'is_test', sa.Column('is_test', sa.Boolean(), nullable=False, server_default=sa.false())),
        ('bookings', 'deletion_level', sa.Column('deletion_level', sa.String(2), nullable=True)),
    ):
        if name not in {c['name'] for c in sa.inspect(bind).get_columns(table)}:
            op.add_column(table, column)
    op.execute("UPDATE articles SET is_test=true WHERE upper(sku) LIKE 'TEST-%'")
    op.execute("""UPDATE bookings b SET is_test=true WHERE EXISTS (SELECT 1 FROM booking_lines l WHERE l.booking_id=b.id)
        AND NOT EXISTS (SELECT 1 FROM booking_lines l JOIN articles a ON a.id=l.article_id WHERE l.booking_id=b.id AND NOT a.is_test)""")
    op.execute("UPDATE bookings SET deletion_level='L1' WHERE deleted_at IS NOT NULL AND deletion_level IS NULL")
    PurgeLog.__table__.create(bind, checkfirst=True)


def downgrade():
    op.drop_table('purge_log')
    op.drop_column('bookings', 'deletion_level')
    op.drop_column('bookings', 'is_test')
    op.drop_column('articles', 'is_test')
