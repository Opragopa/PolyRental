"""Keep a minimal non-PII audit entry when an operator deletes a booking."""
from alembic import op
import sqlalchemy as sa


revision = "20261026_01"
down_revision = "20261025_02"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "booking_deletion_audit" not in inspector.get_table_names():
        op.create_table(
            "booking_deletion_audit",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("deleted_booking_id", sa.Integer(), nullable=False),
            sa.Column("actor_id", sa.BigInteger(), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("booking_deletion_audit")}
    if "ix_booking_deletion_audit_deleted_booking_id" not in indexes:
        op.create_index("ix_booking_deletion_audit_deleted_booking_id", "booking_deletion_audit",
                        ["deleted_booking_id"])


def downgrade():
    op.drop_index("ix_booking_deletion_audit_deleted_booking_id", table_name="booking_deletion_audit")
    op.drop_table("booking_deletion_audit")
