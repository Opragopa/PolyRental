"""Store operator quiet hours separately from mandatory notifications."""
from alembic import op
from app.db import OperatorNotificationPreference
revision = '20261027_18'
down_revision = '20261027_17'
branch_labels = None
depends_on = None


def upgrade():
    OperatorNotificationPreference.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table('operator_notification_preferences')
