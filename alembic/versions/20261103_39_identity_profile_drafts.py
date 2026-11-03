"""Encrypted profile draft retained only while its source identity exists."""
from alembic import op
import sqlalchemy as sa
revision = "20261103_39"
down_revision = "20261103_38"
branch_labels = None
depends_on = None

def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "display_name" not in {column["name"] for column in inspector.get_columns("staff_roles")}:
        op.add_column("staff_roles", sa.Column("display_name", sa.String(200), nullable=False, server_default=""))
    if "identity_profile_drafts" not in inspector.get_table_names():
        op.create_table("identity_profile_drafts",
            sa.Column("identity_id", sa.Integer(), sa.ForeignKey("customer_identities.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("encrypted_payload", sa.LargeBinary(), nullable=False),
            sa.Column("payload_nonce", sa.LargeBinary(), nullable=False))

def downgrade():
    op.drop_table("identity_profile_drafts")
    op.drop_column("staff_roles", "display_name")
