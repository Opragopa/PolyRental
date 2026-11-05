"""Client requests for permission to edit a confirmed booking."""
from alembic import op
import sqlalchemy as sa

revision = "20261105_43"
down_revision = "20261105_42"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("customer_change_requests"):
        return
    op.create_table("customer_change_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("booking_id", sa.Integer(), sa.ForeignKey("bookings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("reviewer_id", sa.BigInteger(), nullable=True),
        sa.Column("change_id", sa.Integer(), sa.ForeignKey("booking_changes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'approved', 'rejected', 'obsolete')", name="customer_change_requests_status_check"))
    op.create_index("ix_customer_change_requests_booking_id", "customer_change_requests", ["booking_id"])
    op.create_index("customer_change_requests_one_pending", "customer_change_requests", ["booking_id"], unique=True, postgresql_where=sa.text("status = 'pending'"))


def downgrade():
    op.drop_table("customer_change_requests")
