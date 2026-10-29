"""Publish inventory/handover invalidations and index pending deadlines."""
from alembic import op

revision = "20261029_31"
down_revision = "20261029_30"
branch_labels = None
depends_on = None

TABLES = ("booking_handovers", "equipment_owners", "equipment_features")


def upgrade():
    op.execute("CREATE INDEX IF NOT EXISTS booking_changes_deadline_idx ON booking_changes (status, deadline)")
    for table in TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS polyrental_availability_changed ON {table}")
        op.execute(f"CREATE TRIGGER polyrental_availability_changed AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION polyrental_availability_changed()")


def downgrade():
    for table in TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS polyrental_availability_changed ON {table}")
    op.execute("DROP INDEX IF EXISTS booking_changes_deadline_idx")
