"""Reserve annual numbers, then backfill in short committed batches.

The trigger keeps older workers compatible during a rolling deployment. Schema
changes require brief PostgreSQL metadata locks. Reservation scanning and batch
updates run without a table-wide lock; annual counter rows serialize allocation.
"""
from alembic import op

revision = '20261027_08'
down_revision = '20261026_07'
branch_labels = None
depends_on = None


def upgrade():
    from app.number_backfill import backfill_request_numbers
    with op.get_context().autocommit_block():
        op.execute('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS human_number VARCHAR(32)')
        op.execute('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS bookings_human_number_unique ON bookings (human_number)')
        backfill_request_numbers(op.get_bind())


def downgrade():
    op.execute('DROP TRIGGER IF EXISTS polyrental_number_after ON bookings')
    op.execute('DROP TRIGGER IF EXISTS polyrental_number_before ON bookings')
    op.execute('DROP FUNCTION IF EXISTS polyrental_audit_request_number()')
    op.execute('DROP FUNCTION IF EXISTS polyrental_assign_request_number()')
    op.drop_index('bookings_human_number_unique', table_name='bookings')
    op.drop_column('bookings', 'human_number')
    op.drop_table('request_number_backfill')
    op.drop_table('request_number_counters')
