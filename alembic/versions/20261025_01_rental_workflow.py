"""Article workflow and encrypted identity boundary.

Revision ID: 20261025_01
Revises:
"""
from alembic import op
import sqlalchemy as sa

from app.db import Base

revision = "20261025_01"
down_revision = None
branch_labels = None
depends_on = None


def _columns(inspector, table):
    return {column["name"] for column in inspector.get_columns(table)}


def upgrade():
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    # Create independent tables first so legacy foreign keys can reference articles.
    Base.metadata.tables["articles"].create(connection, checkfirst=True)
    if "equipment" in tables:
        columns = _columns(inspector, "equipment")
        additions = {
            "image_url": sa.Column("image_url", sa.String(500), nullable=False, server_default=""),
            "article_id": sa.Column("article_id", sa.Integer(), sa.ForeignKey("articles.id"), nullable=True),
            "storage_location": sa.Column("storage_location", sa.String(120), nullable=False, server_default=""),
            "health_percent": sa.Column("health_percent", sa.Integer(), nullable=True),
            "charge_percent": sa.Column("charge_percent", sa.Integer(), nullable=True),
        }
        for name, column in additions.items():
            if name not in columns:
                op.add_column("equipment", column)
    if "bookings" in tables:
        columns = _columns(inspector, "bookings")
        additions = {
            "client_request_id": sa.Column("client_request_id", sa.String(36), nullable=True),
            "identity_status": sa.Column("identity_status", sa.String(30), nullable=False, server_default="not_required"),
            "act_signed_at": sa.Column("act_signed_at", sa.DateTime(timezone=True), nullable=True),
            "act_signed_by": sa.Column("act_signed_by", sa.BigInteger(), nullable=True),
            "returned_at": sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
        }
        for name, column in additions.items():
            if name not in columns:
                op.add_column("bookings", column)
    if "booking_lines" in tables and "billable_quantity" not in _columns(inspector, "booking_lines"):
        op.add_column("booking_lines", sa.Column("billable_quantity", sa.Integer(), nullable=False, server_default="0"))
        op.execute("UPDATE booking_lines SET billable_quantity = quantity WHERE billable_quantity = 0")
    Base.metadata.create_all(connection)
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS bookings_customer_request_unique ON bookings (customer_id, client_request_id)")
    op.execute("CREATE INDEX IF NOT EXISTS equipment_article_idx ON equipment (article_id)")
    # Exact grouping only: name, rate, description and image must all match.
    op.execute("""
        INSERT INTO articles (sku, name, description, image_url, hourly_rate, category,
                              inspection_profile, buffer_hours, is_active)
        SELECT 'LEGACY-' || MIN(id)::text, name, COALESCE(description, ''),
               COALESCE(image_url, ''), hourly_rate, 'generic', 'generic', 24, true
        FROM equipment WHERE article_id IS NULL
        GROUP BY name, hourly_rate, COALESCE(description, ''), COALESCE(image_url, '')
        ON CONFLICT (sku) DO NOTHING
    """)
    op.execute("""
        UPDATE equipment e SET article_id = a.id FROM articles a
        WHERE e.article_id IS NULL AND e.name = a.name AND e.hourly_rate = a.hourly_rate
          AND COALESCE(e.description, '') = a.description AND COALESCE(e.image_url, '') = a.image_url
    """)
    op.execute("""
        INSERT INTO booking_lines (booking_id, article_id, quantity, hourly_rate, auto_added)
        SELECT bi.booking_id, e.article_id, COUNT(*), bi.hourly_rate, false
        FROM booking_items bi JOIN equipment e ON e.id = bi.equipment_id
        LEFT JOIN booking_lines bl ON bl.booking_id = bi.booking_id AND bl.article_id = e.article_id
        WHERE bl.id IS NULL GROUP BY bi.booking_id, e.article_id, bi.hourly_rate
    """)
    op.execute("""
        INSERT INTO booking_assets (booking_id, equipment_id, booking_line_id)
        SELECT bi.booking_id, bi.equipment_id, bl.id
        FROM booking_items bi JOIN equipment e ON e.id = bi.equipment_id
        JOIN booking_lines bl ON bl.booking_id = bi.booking_id AND bl.article_id = e.article_id
        ON CONFLICT DO NOTHING
    """)


def downgrade():
    raise RuntimeError("This migration contains data transformation and cannot be safely downgraded")
