"""Store optional category previews."""
from alembic import op
import sqlalchemy as sa

revision = "20261110_44"
down_revision = "20261105_43"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("catalog_categories")}
    if "image_webp" not in columns:
        op.add_column("catalog_categories", sa.Column("image_webp", sa.LargeBinary(), nullable=True))


def downgrade():
    op.drop_column("catalog_categories", "image_webp")
