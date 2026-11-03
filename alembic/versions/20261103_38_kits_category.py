"""Add the ready-made kits category to existing catalogs."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_38"
down_revision = "20261103_37"
branch_labels = None
depends_on = None


def upgrade():
    op.get_bind().execute(sa.text("""
        INSERT INTO catalog_categories (code, name, normalized_name, icon)
        VALUES (:code, :name, :normalized_name, :icon)
        ON CONFLICT DO NOTHING
    """), {"code": "kits", "name": "Готовые комплекты",
           "normalized_name": "готовые комплекты", "icon": "equipment"})


def downgrade():
    pass
