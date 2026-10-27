"""Assign stable human-readable numbers and retain annual counters."""
from alembic import op
import sqlalchemy as sa

revision = "20261027_08"
down_revision = "20261026_07"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("bookings")}
    if "human_number" not in columns:
        op.add_column("bookings", sa.Column("human_number", sa.String(32), nullable=True))
    op.execute("""CREATE TABLE IF NOT EXISTS request_number_counters (
        year INTEGER PRIMARY KEY, last_sequence INTEGER NOT NULL
    )""")
    # Prevent older workers inserting unnumbered rows while the snapshot is assigned.
    op.execute("LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE")
    op.execute("""WITH numbered AS (
        SELECT id, EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer AS year,
               row_number() OVER (PARTITION BY EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')
                                  ORDER BY created_at, id) AS seq
        FROM bookings
    )
    UPDATE bookings b SET human_number = 'ТС' || to_char(n.year % 100, 'FM00') ||
        CASE WHEN n.seq < 10000 THEN lpad(n.seq::text, 4, '0') ELSE n.seq::text END
    FROM numbered n WHERE b.id = n.id AND b.human_number IS NULL""")
    op.execute("""INSERT INTO request_number_counters (year, last_sequence)
        SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer,
               MAX(substring(human_number FROM 5)::integer)
        FROM bookings WHERE human_number IS NOT NULL
        GROUP BY 1
        ON CONFLICT (year) DO UPDATE SET last_sequence =
          GREATEST(request_number_counters.last_sequence, EXCLUDED.last_sequence)""")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS bookings_human_number_unique ON bookings (human_number)")
    op.execute("""INSERT INTO audit (booking_id, actor_id, action)
        SELECT b.id, 0, 'number_assigned' FROM bookings b
        WHERE b.human_number IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM audit a WHERE a.booking_id = b.id AND a.action = 'number_assigned')""")


def downgrade():
    op.drop_index("bookings_human_number_unique", table_name="bookings")
    op.drop_column("bookings", "human_number")
    op.drop_table("request_number_counters")
