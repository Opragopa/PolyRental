"""Transactional revision for shared Redis cache invalidation."""
from alembic import op

revision = '20261102_36'
down_revision = '20261102_35'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('CREATE TABLE IF NOT EXISTS availability_cache_revision (id SMALLINT PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL DEFAULT 0)')
    op.execute('INSERT INTO availability_cache_revision (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING')
    op.execute("""CREATE OR REPLACE FUNCTION polyrental_availability_changed() RETURNS trigger AS $$
        BEGIN
            UPDATE availability_cache_revision SET revision = revision + 1 WHERE id = 1;
            PERFORM pg_notify('polyrental_availability', 'changed');
            RETURN NULL;
        END; $$ LANGUAGE plpgsql""")
    op.execute('DROP TRIGGER IF EXISTS polyrental_availability_changed ON catalog_categories')
    op.execute('CREATE TRIGGER polyrental_availability_changed AFTER INSERT OR UPDATE OR DELETE ON catalog_categories FOR EACH STATEMENT EXECUTE FUNCTION polyrental_availability_changed()')


def downgrade():
    op.execute('DROP TRIGGER IF EXISTS polyrental_availability_changed ON catalog_categories')
    op.execute("""CREATE OR REPLACE FUNCTION polyrental_availability_changed() RETURNS trigger AS $$
        BEGIN PERFORM pg_notify('polyrental_availability', 'changed'); RETURN NULL; END; $$ LANGUAGE plpgsql""")
    op.execute('DROP TABLE IF EXISTS availability_cache_revision')
