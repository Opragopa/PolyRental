"""Record encrypted rework reasons and distinguish return inspection cycles."""
from alembic import op
import sqlalchemy as sa

revision = "20261028_28"
down_revision = "20261028_27"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "inspection_cycle_started_at" not in {column["name"] for column in inspector.get_columns("bookings")}:
        op.add_column("bookings", sa.Column("inspection_cycle_started_at", sa.DateTime(timezone=True), nullable=True))
    if "booking_rework" not in inspector.get_table_names():
        op.create_table(
        "booking_rework",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("booking_id", sa.Integer(), sa.ForeignKey("bookings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.BigInteger(), nullable=False),
        sa.Column("from_status", sa.String(30), nullable=False),
        sa.Column("to_status", sa.String(30), nullable=False),
        sa.Column("encrypted_comment", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        )
    op.execute("CREATE INDEX IF NOT EXISTS ix_booking_rework_booking_id ON booking_rework (booking_id)")


def downgrade():
    op.drop_index("ix_booking_rework_booking_id", table_name="booking_rework")
    op.drop_table("booking_rework")
    op.drop_column("bookings", "inspection_cycle_started_at")
