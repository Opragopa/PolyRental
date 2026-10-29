"""Store bounded catalogue thumbnails in PostgreSQL."""
from alembic import op

revision = "20261030_33"
down_revision = "20261029_32"
branch_labels = None
depends_on = None


def upgrade():
    from app.db import ArticleImage
    ArticleImage.__table__.create(op.get_bind(), checkfirst=True)
    op.execute("DROP TRIGGER IF EXISTS polyrental_availability_changed ON article_images")
    op.execute("CREATE TRIGGER polyrental_availability_changed AFTER INSERT OR UPDATE OR DELETE ON article_images FOR EACH STATEMENT EXECUTE FUNCTION polyrental_availability_changed()")


def downgrade():
    # Keep catalogue photos available when rolling forward again.
    pass
