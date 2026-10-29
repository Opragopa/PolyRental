"""Handover, inventory and encrypted request-change workflows (additive)."""
from alembic import op

revision = "20261029_30"
down_revision = "20261028_29"
branch_labels = None
depends_on = None


def upgrade():
    from app.db import (TrustedSigner, EquipmentOwner, EquipmentFeature, InventoryAudit,
                        BookingHandover, BookingChange)
    for model in (TrustedSigner, EquipmentOwner, EquipmentFeature, InventoryAudit,
                  BookingHandover, BookingChange):
        model.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    # Downgrade intentionally preserves operational records and paper signatures.
    # Old application versions ignore these additive tables.
    pass
