"""Reserve annual numbers, then backfill in short committed batches.

The trigger keeps older workers compatible during a rolling deployment. Schema
changes and the brief reservation snapshot take PostgreSQL metadata/table locks;
the potentially long updates themselves run in independent transactions.
"""
from alembic import op

revision = '20261027_08'
down_revision = '20261026_07'
branch_labels = None
depends_on = None


def upgrade():
    context = op.get_context()
    with context.autocommit_block():
        bind = op.get_bind()
        op.execute('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS human_number VARCHAR(32)')
        op.execute('CREATE TABLE IF NOT EXISTS request_number_counters (year INTEGER PRIMARY KEY, last_sequence INTEGER NOT NULL)')
        op.execute('CREATE TABLE IF NOT EXISTS request_number_backfill (booking_id INTEGER PRIMARY KEY, year INTEGER NOT NULL, sequence BIGINT NOT NULL)')
        op.execute('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS bookings_human_number_unique ON bookings (human_number)')
        # Reserve an ordered snapshot and install the old-writer trigger in one
        # short transaction. Backfill work below never holds this table lock.
        op.execute('BEGIN')
        try:
            op.execute('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE')
            op.execute('''WITH years AS (
                  SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer AS year,
                         COALESCE(MAX(substring(human_number FROM 5)::bigint), 0) AS assigned
                  FROM bookings GROUP BY 1
                ), base AS (
                  SELECT y.year, GREATEST(y.assigned, COALESCE(c.last_sequence, 0)) AS last_sequence
                  FROM years y LEFT JOIN request_number_counters c ON c.year=y.year
                ), numbered AS (
                  SELECT b.id, EXTRACT(YEAR FROM b.created_at AT TIME ZONE 'Europe/Moscow')::integer AS year,
                         base.last_sequence + row_number() OVER (
                           PARTITION BY EXTRACT(YEAR FROM b.created_at AT TIME ZONE 'Europe/Moscow')
                           ORDER BY b.created_at, b.id) AS sequence
                  FROM bookings b JOIN base ON base.year=EXTRACT(YEAR FROM b.created_at AT TIME ZONE 'Europe/Moscow')::integer
                  WHERE b.human_number IS NULL
                )
                INSERT INTO request_number_backfill (booking_id, year, sequence)
                SELECT id, year, sequence FROM numbered
                ON CONFLICT (booking_id) DO NOTHING''')
            op.execute('''INSERT INTO request_number_counters (year, last_sequence)
                SELECT year, MAX(sequence)::integer FROM request_number_backfill GROUP BY year
                ON CONFLICT (year) DO UPDATE SET last_sequence=GREATEST(request_number_counters.last_sequence, EXCLUDED.last_sequence)''')
            op.execute('''INSERT INTO request_number_counters (year, last_sequence)
                SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer,
                       MAX(substring(human_number FROM 5)::integer)
                FROM bookings WHERE human_number IS NOT NULL GROUP BY 1
                ON CONFLICT (year) DO UPDATE SET last_sequence=GREATEST(request_number_counters.last_sequence, EXCLUDED.last_sequence)''')
            op.execute('''CREATE OR REPLACE FUNCTION polyrental_assign_request_number() RETURNS trigger AS $$
                DECLARE yr integer; seq integer;
                BEGIN
                  IF NEW.human_number IS NULL THEN
                    yr := EXTRACT(YEAR FROM NEW.created_at AT TIME ZONE 'Europe/Moscow')::integer;
                    INSERT INTO request_number_counters (year, last_sequence) VALUES (yr, 1)
                    ON CONFLICT (year) DO UPDATE SET last_sequence=request_number_counters.last_sequence + 1
                    RETURNING last_sequence INTO seq;
                    NEW.human_number := 'ТС' || to_char(yr % 100, 'FM00') ||
                        CASE WHEN seq < 10000 THEN lpad(seq::text, 4, '0') ELSE seq::text END;
                  END IF;
                  RETURN NEW;
                END; $$ LANGUAGE plpgsql''')
            op.execute('''CREATE OR REPLACE FUNCTION polyrental_audit_request_number() RETURNS trigger AS $$
                BEGIN
                  INSERT INTO audit (booking_id, actor_id, action) VALUES (NEW.id, NEW.customer_id, 'number_assigned');
                  RETURN NEW;
                END; $$ LANGUAGE plpgsql''')
            op.execute('DROP TRIGGER IF EXISTS polyrental_number_before ON bookings')
            op.execute('CREATE TRIGGER polyrental_number_before BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION polyrental_assign_request_number()')
            op.execute('DROP TRIGGER IF EXISTS polyrental_number_after ON bookings')
            op.execute('CREATE TRIGGER polyrental_number_after AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION polyrental_audit_request_number()')
            op.execute('COMMIT')
        except Exception:
            op.execute('ROLLBACK')
            raise
        while True:
            result = bind.exec_driver_sql('''WITH batch AS (
                    SELECT b.id FROM bookings b JOIN request_number_backfill m ON m.booking_id=b.id
                    WHERE b.human_number IS NULL ORDER BY b.id LIMIT 1000
                )
                UPDATE bookings b SET human_number='ТС' || to_char(mod(m.year, 100), 'FM00') ||
                  CASE WHEN m.sequence < 10000 THEN lpad(m.sequence::text, 4, '0') ELSE m.sequence::text END
                FROM request_number_backfill m, batch WHERE b.id=batch.id AND m.booking_id=b.id''')
            if not result.rowcount:
                break
        op.execute('''INSERT INTO audit (booking_id, actor_id, action)
            SELECT b.id, 0, 'number_assigned' FROM bookings b JOIN request_number_backfill m ON m.booking_id=b.id
            WHERE b.human_number IS NOT NULL AND NOT EXISTS
              (SELECT 1 FROM audit a WHERE a.booking_id=b.id AND a.action='number_assigned')''')


def downgrade():
    op.execute('DROP TRIGGER IF EXISTS polyrental_number_after ON bookings')
    op.execute('DROP TRIGGER IF EXISTS polyrental_number_before ON bookings')
    op.execute('DROP FUNCTION IF EXISTS polyrental_audit_request_number()')
    op.execute('DROP FUNCTION IF EXISTS polyrental_assign_request_number()')
    op.drop_index('bookings_human_number_unique', table_name='bookings')
    op.drop_column('bookings', 'human_number')
    op.drop_table('request_number_backfill')
    op.drop_table('request_number_counters')
