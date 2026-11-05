"""Remember public Telegram names independently of booking/identity data."""
from alembic import op
import sqlalchemy as sa

revision = "20261105_42"
down_revision = "20261105_41"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("client_profiles")}
    if "display_name" not in columns:
        op.add_column("client_profiles", sa.Column("display_name", sa.String(200), nullable=False, server_default=""))


def downgrade():
    op.drop_column("client_profiles", "display_name")
