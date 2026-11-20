"""Optional rental purpose and a shared administrator switch."""
from alembic import op

revision = "20261113_47"
down_revision = "20261113_46"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_purpose TEXT NOT NULL DEFAULT ''")
    op.execute("""CREATE TABLE IF NOT EXISTS booking_settings (
        id INTEGER PRIMARY KEY CHECK (id=1),
        rental_purpose_enabled BOOLEAN NOT NULL DEFAULT true)""")


def downgrade():
    op.execute("DROP TABLE booking_settings")
    op.execute("ALTER TABLE bookings DROP COLUMN rental_purpose")
