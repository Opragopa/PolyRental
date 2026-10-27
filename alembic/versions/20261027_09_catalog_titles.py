"""Add structured catalog title fields without changing original names."""
from alembic import op
import sqlalchemy as sa

from app.catalog_titles import infer_structured
from app.db import ArticleTitleAudit

revision = "20261027_09"
down_revision = "20261027_08"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("articles")}
    for name, size in (("kind", 80), ("brand", 100), ("key_spec", 120)):
        if name not in columns:
            op.add_column("articles", sa.Column(name, sa.String(size), nullable=False, server_default=""))
    ArticleTitleAudit.__table__.create(bind, checkfirst=True)
    rows = bind.execute(sa.text("SELECT id, name, category FROM articles WHERE kind = '' AND brand = '' AND key_spec = ''"))
    batch = []
    for row in rows:
        batch.append({"article_id": row.id, **infer_structured(row.name, row.category)})
    if batch:
        bind.execute(sa.text("UPDATE articles SET kind=:kind, brand=:brand, key_spec=:key_spec WHERE id=:article_id AND kind='' AND brand='' AND key_spec=''"), batch)


def downgrade():
    op.drop_table("article_title_audit")
    for name in ("key_spec", "brand", "kind"):
        op.drop_column("articles", name)
