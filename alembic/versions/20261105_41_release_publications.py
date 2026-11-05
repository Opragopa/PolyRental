"""Track one channel publication per regular release and delivery outcome."""
from alembic import op
import sqlalchemy as sa

revision = "20261105_41"
down_revision = "20261104_40"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("release_publications"):
        return
    op.create_table("release_publications",
        sa.Column("channel_id", sa.BigInteger(), primary_key=True),
        sa.Column("version", sa.String(32), primary_key=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("message_id", sa.BigInteger(), nullable=True),
        sa.Column("last_error", sa.String(80), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")))


def downgrade():
    op.drop_table("release_publications")
