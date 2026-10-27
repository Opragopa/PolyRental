"""Store staff subroles; seed the configured administrators."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.roles import configured_ids

revision = "20261028_27"
down_revision = "20261027_26"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "staff_roles",
        sa.Column("telegram_id", sa.BigInteger(), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False),
        sa.CheckConstraint("role IN ('operator', 'manager', 'admin')", name="staff_roles_role_check"),
    )
    roles = sa.table("staff_roles", sa.column("telegram_id", sa.BigInteger()),
                     sa.column("role", sa.String(16)))
    for telegram_id in configured_ids("ADMIN_IDS"):
        op.execute(insert(roles).values(telegram_id=telegram_id, role="admin")
                   .on_conflict_do_nothing(index_elements=["telegram_id"]))


def downgrade():
    op.drop_table("staff_roles")
