"""Online legacy numbering without a table lock around the reservation scan.

The caller uses an autocommit connection. Installing the triggers still needs
PostgreSQL's brief metadata locks. Only annual counter rows serialize number
allocation; candidate scanning and batch updates do not hold those locks.
"""
from sqlalchemy import text


def backfill_request_numbers(connection, batch_size=1000):
    connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS request_number_counters (year INTEGER PRIMARY KEY, last_sequence INTEGER NOT NULL)")
    connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS request_number_backfill (booking_id INTEGER PRIMARY KEY, year INTEGER NOT NULL, sequence BIGINT NOT NULL)")
    connection.exec_driver_sql("""INSERT INTO request_number_counters (year,last_sequence)
        SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer,
               MAX(substring(human_number FROM 5)::integer)
        FROM bookings WHERE human_number IS NOT NULL GROUP BY 1
        ON CONFLICT (year) DO UPDATE SET last_sequence=GREATEST(request_number_counters.last_sequence,EXCLUDED.last_sequence)""")
    connection.exec_driver_sql("""CREATE OR REPLACE FUNCTION polyrental_assign_request_number() RETURNS trigger AS $$
        DECLARE yr integer; seq integer;
        BEGIN
          IF NEW.human_number IS NULL THEN
            yr := EXTRACT(YEAR FROM NEW.created_at AT TIME ZONE 'Europe/Moscow')::integer;
            INSERT INTO request_number_counters (year,last_sequence) VALUES (yr,1)
            ON CONFLICT (year) DO UPDATE SET last_sequence=request_number_counters.last_sequence+1
            RETURNING last_sequence INTO seq;
            NEW.human_number := 'ТС'||to_char(mod(yr,100),'FM00')||
                CASE WHEN seq<10000 THEN lpad(seq::text,4,'0') ELSE seq::text END;
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql""")
    connection.exec_driver_sql("""CREATE OR REPLACE FUNCTION polyrental_audit_request_number() RETURNS trigger AS $$
        BEGIN INSERT INTO audit (booking_id,actor_id,action) VALUES (NEW.id,NEW.customer_id,'number_assigned'); RETURN NEW; END;
        $$ LANGUAGE plpgsql""")
    for name, event, function in (("polyrental_number_before","BEFORE","polyrental_assign_request_number"),
                                  ("polyrental_number_after","AFTER","polyrental_audit_request_number")):
        connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {name} ON bookings")
        connection.exec_driver_sql(f"CREATE TRIGGER {name} {event} INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION {function}()")
    connection.exec_driver_sql("DROP TABLE IF EXISTS pg_temp.polyrental_number_candidates")
    connection.exec_driver_sql("""CREATE TEMP TABLE polyrental_number_candidates AS
        SELECT b.id,EXTRACT(YEAR FROM b.created_at AT TIME ZONE 'Europe/Moscow')::integer AS year,
               row_number() OVER (PARTITION BY EXTRACT(YEAR FROM b.created_at AT TIME ZONE 'Europe/Moscow') ORDER BY b.created_at,b.id) AS ordinal
        FROM bookings b WHERE b.human_number IS NULL
          AND NOT EXISTS (SELECT 1 FROM request_number_backfill m WHERE m.booking_id=b.id)""")
    counts=connection.exec_driver_sql("SELECT year,count(*) FROM polyrental_number_candidates GROUP BY year ORDER BY year").all()
    for year,count in counts:
        # This small statement commits before the potentially large mapping scan.
        end=connection.execute(text("""INSERT INTO request_number_counters (year,last_sequence) VALUES (:year,:count)
            ON CONFLICT (year) DO UPDATE SET last_sequence=request_number_counters.last_sequence+EXCLUDED.last_sequence
            RETURNING last_sequence"""),{"year":year,"count":count}).scalar_one()
        connection.execute(text("""INSERT INTO request_number_backfill (booking_id,year,sequence)
            SELECT id,year,:offset+ordinal FROM polyrental_number_candidates WHERE year=:year
            ON CONFLICT (booking_id) DO NOTHING"""),{"year":year,"offset":end-count})
    updated=0
    while True:
        result=connection.execute(text("""WITH batch AS (
            SELECT b.id FROM bookings b JOIN request_number_backfill m ON m.booking_id=b.id
            WHERE b.human_number IS NULL ORDER BY b.id LIMIT :batch_size)
            UPDATE bookings b SET human_number='ТС'||to_char(mod(m.year,100),'FM00')||
              CASE WHEN m.sequence<10000 THEN lpad(m.sequence::text,4,'0') ELSE m.sequence::text END
            FROM request_number_backfill m,batch WHERE b.id=batch.id AND m.booking_id=b.id"""),{"batch_size":batch_size})
        if not result.rowcount: break
        updated+=result.rowcount
    connection.exec_driver_sql("""INSERT INTO audit (booking_id,actor_id,action)
        SELECT b.id,0,'number_assigned' FROM bookings b JOIN request_number_backfill m ON m.booking_id=b.id
        WHERE b.human_number IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM audit a WHERE a.booking_id=b.id AND a.action='number_assigned')""")
    connection.exec_driver_sql("DROP TABLE polyrental_number_candidates")
    return updated
