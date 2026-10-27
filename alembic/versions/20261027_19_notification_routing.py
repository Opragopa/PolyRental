"""Cancel queued deliveries superseded by owner-only routing."""
from alembic import op
import sqlalchemy as sa
revision = '20261027_19'
down_revision = '20261027_18'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {c['name'] for c in sa.inspect(bind).get_columns('notification_deliveries')}
    if 'cancelled_at' not in columns:
        op.add_column('notification_deliveries', sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True))
    op.execute("""UPDATE notification_deliveries n SET cancelled_at=now()
        WHERE n.sent_at IS NULL AND n.cancelled_at IS NULL AND (
          (left(n.event, 8)='booking_' AND n.event <> 'booking_created_customer') OR
          (n.event='identity_submitted' AND NOT EXISTS
             (SELECT 1 FROM bookings b WHERE b.id=n.booking_id AND b.assignee_id=n.recipient_id)))""")


def downgrade():
    op.drop_column('notification_deliveries', 'cancelled_at')
