"""Keep retired articles and their equipment for historical bookings."""
from alembic import op
import sqlalchemy as sa

revision = "20261104_40"
down_revision = "20261103_39"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("articles")}
    if "archived_at" not in columns:
        op.add_column("articles", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    if "archived_by" not in columns:
        op.add_column("articles", sa.Column("archived_by", sa.BigInteger(), nullable=True))


def downgrade():
    op.drop_column("articles", "archived_by")
    op.drop_column("articles", "archived_at")
