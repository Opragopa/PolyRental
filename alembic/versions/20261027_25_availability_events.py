"""Publish non-sensitive availability invalidations at transaction commit."""
from alembic import op
revision = '20261027_25'
down_revision = '20261027_24'
branch_labels = None
depends_on = None
TABLES = ('bookings', 'booking_lines', 'booking_assets', 'articles', 'equipment')


def upgrade():
    op.execute("""CREATE OR REPLACE FUNCTION polyrental_availability_changed() RETURNS trigger AS $$
    BEGIN PERFORM pg_notify('polyrental_availability', 'changed'); RETURN NULL; END; $$ LANGUAGE plpgsql""")
    for table in TABLES:
        op.execute(f'DROP TRIGGER IF EXISTS polyrental_availability_changed ON {table}')
        op.execute(f'CREATE TRIGGER polyrental_availability_changed AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION polyrental_availability_changed()')


def downgrade():
    for table in TABLES:
        op.execute(f'DROP TRIGGER IF EXISTS polyrental_availability_changed ON {table}')
    op.execute('DROP FUNCTION IF EXISTS polyrental_availability_changed()')
