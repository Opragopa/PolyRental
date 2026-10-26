"""Encrypted advisory document verdicts; old uploads remain manual review."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_07"
down_revision = "20261026_06"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("identity_documents")}
    for name in ("encrypted_check", "check_nonce"):
        if name not in columns:
            op.add_column("identity_documents", sa.Column(name, sa.LargeBinary(), nullable=True))


def downgrade():
    op.drop_column("identity_documents", "check_nonce")
    op.drop_column("identity_documents", "encrypted_check")
