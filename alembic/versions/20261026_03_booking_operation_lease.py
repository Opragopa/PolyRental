"""Claim only the booking stage currently handled by an operator."""

from alembic import op
import sqlalchemy as sa


revision = "20261026_03"
down_revision = "20261026_02"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    if "booking_operation_leases" not in sa.inspect(connection).get_table_names():
        op.create_table(
            "booking_operation_leases",
            sa.Column("booking_id", sa.Integer(), sa.ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("stage", sa.String(length=30), primary_key=True),
            sa.Column("actor_id", sa.BigInteger(), nullable=False),
            sa.Column("actor_name", sa.String(length=160), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        )
    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("booking_operation_leases")}
    if "booking_operation_leases_expires_at_idx" not in indexes and "ix_booking_operation_leases_expires_at" not in indexes:
        op.create_index("booking_operation_leases_expires_at_idx", "booking_operation_leases", ["expires_at"])


def downgrade():
    connection = op.get_bind()
    if "booking_operation_leases" in sa.inspect(connection).get_table_names():
        indexes = {index["name"] for index in sa.inspect(connection).get_indexes("booking_operation_leases")}
        if "booking_operation_leases_expires_at_idx" in indexes:
            op.drop_index("booking_operation_leases_expires_at_idx", table_name="booking_operation_leases")
        op.drop_table("booking_operation_leases")
