"""Store encrypted issue documents and stable receipt numbers."""
from alembic import op
import sqlalchemy as sa


revision = "20261026_02"
down_revision = "20261026_01"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("bookings")}
    if "receipt_number" not in columns:
        op.add_column("bookings", sa.Column("receipt_number", sa.String(length=20), nullable=True))
    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("bookings")}
    if "bookings_receipt_number_unique" not in indexes:
        op.create_index("bookings_receipt_number_unique", "bookings", ["receipt_number"], unique=True)
    if "booking_documents" not in inspector.get_table_names():
        op.create_table(
            "booking_documents",
            sa.Column("booking_id", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(length=20), nullable=False),
            sa.Column("filename", sa.String(length=160), nullable=False),
            sa.Column("media_type", sa.String(length=120), nullable=False),
            sa.Column("encrypted_data", sa.LargeBinary(), nullable=False),
            sa.Column("nonce", sa.LargeBinary(), nullable=False),
            sa.Column("sha256", sa.String(length=64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.ForeignKeyConstraint(["booking_id"], ["bookings.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("booking_id", "kind"),
        )


def downgrade():
    op.drop_table("booking_documents")
    op.drop_index("bookings_receipt_number_unique", table_name="bookings")
    op.drop_column("bookings", "receipt_number")
