"""Simplify inspections and remove redundant student-card backs."""
from alembic import op
import sqlalchemy as sa

revision = "20261025_02"
down_revision = "20261025_01"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("inspections")}
    if "defect" not in columns:
        op.add_column("inspections", sa.Column("defect", sa.Text(), nullable=False, server_default=""))
    if "estimated_cost" not in columns:
        op.add_column("inspections", sa.Column("estimated_cost", sa.Numeric(12, 2), nullable=False, server_default="0"))
    if "charge_customer" not in columns:
        op.add_column("inspections", sa.Column("charge_customer", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("""
        INSERT INTO pii_audit (booking_id, actor_id, action, created_at)
        SELECT ci.booking_id, 0, 'student_back_deleted', now()
        FROM identity_documents d
        JOIN customer_identities ci ON ci.id = d.identity_id
        WHERE d.kind = 'student_back'
    """)
    op.execute("DELETE FROM identity_documents WHERE kind = 'student_back'")


def downgrade():
    op.drop_column("inspections", "charge_customer")
    op.drop_column("inspections", "estimated_cost")
    op.drop_column("inspections", "defect")
