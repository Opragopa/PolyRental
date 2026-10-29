"""Timed inventory blocks, optional reminders and staff navigation."""
from alembic import op

revision = "20261029_32"
down_revision = "20261029_31"
branch_labels = None
depends_on = None


def upgrade():
    from app.db import EquipmentBlock, StaffNavigation, BookingReminder
    for model in (EquipmentBlock, StaffNavigation, BookingReminder):
        model.__table__.create(op.get_bind(), checkfirst=True)
    op.execute("CREATE INDEX IF NOT EXISTS equipment_blocks_interval_idx ON equipment_blocks (equipment_id, starts_at, ends_at) WHERE released_at IS NULL")
    op.execute("DROP TRIGGER IF EXISTS polyrental_availability_changed ON equipment_blocks")
    op.execute("CREATE TRIGGER polyrental_availability_changed AFTER INSERT OR UPDATE OR DELETE ON equipment_blocks FOR EACH STATEMENT EXECUTE FUNCTION polyrental_availability_changed()")


def downgrade():
    # Preserve operational blocks and delivery markers across rollback.
    pass
