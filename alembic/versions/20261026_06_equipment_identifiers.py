"""Separate internal asset codes from optional manufacturer and inventory IDs."""

from alembic import op
import sqlalchemy as sa


revision = "20261026_06"
down_revision = "20261026_05"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("equipment")}
    if "serial_number" not in columns:
        op.add_column("equipment", sa.Column("serial_number", sa.String(length=80), nullable=True))
    if "asset_inventory_code" not in columns:
        op.add_column("equipment", sa.Column("asset_inventory_code", sa.String(length=80), nullable=True))
    indexes = {index["name"] for index in inspector.get_indexes("equipment")}
    if "equipment_serial_number_idx" not in indexes:
        op.create_index("equipment_serial_number_idx", "equipment", ["serial_number"])
    unique_sets = {tuple(constraint["column_names"] or []) for constraint in inspector.get_unique_constraints("equipment")}
    if ("asset_inventory_code",) not in unique_sets:
        op.create_unique_constraint("equipment_asset_inventory_code_unique", "equipment", ["asset_inventory_code"])


def downgrade():
    op.drop_constraint("equipment_asset_inventory_code_unique", "equipment", type_="unique")
    op.drop_index("equipment_serial_number_idx", table_name="equipment")
    op.drop_column("equipment", "asset_inventory_code")
    op.drop_column("equipment", "serial_number")
