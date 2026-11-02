"""Inventory ownership and append-only feature records."""
from datetime import datetime, timezone

from sqlalchemy import select

from .db import Equipment, EquipmentFeature, EquipmentOwner, InventoryAudit, Session
from .roles import staff_allows

MAIN_OWNER = "Медиацентр Полимер"


def composition_items(article):
    import re
    return list(dict.fromkeys(item.strip() for item in re.split(r"[\n;]+",article.composition or "") if item.strip()))


def require_role(actor_id, role="operator"):
    if not staff_allows(actor_id, role):
        raise PermissionError("Недостаточно прав для этого действия")


def inventory_details(equipment_id, session=None, customer=False):
    if session is None:
        with Session() as current:
            return inventory_details(equipment_id, current, customer)
    owner = session.get(EquipmentOwner, equipment_id)
    features = session.scalars(select(EquipmentFeature).where(
        EquipmentFeature.equipment_id == equipment_id, EquipmentFeature.deleted_at.is_(None))
        .order_by(EquipmentFeature.id)).all()
    result = {"features": [{"id": row.id, "description": row.description, "source": row.source}
                           for row in features]}
    if owner and owner.name and (not customer or owner.name.casefold() != MAIN_OWNER.casefold()):
        result["owner"] = owner.name
        if not customer and owner.contact:
            result["owner_contact"] = owner.contact
    return result


def inventory_details_batch(equipment_ids, session):
    """Load operator-visible owner and feature details in two queries."""
    result = {equipment_id: {"features": []} for equipment_id in equipment_ids}
    if not result:
        return result
    for owner in session.scalars(select(EquipmentOwner).where(EquipmentOwner.equipment_id.in_(result))):
        if owner.name:
            result[owner.equipment_id]["owner"] = owner.name
            if owner.contact:
                result[owner.equipment_id]["owner_contact"] = owner.contact
    for feature in session.scalars(select(EquipmentFeature).where(EquipmentFeature.equipment_id.in_(result), EquipmentFeature.deleted_at.is_(None)).order_by(EquipmentFeature.id)):
        result[feature.equipment_id]["features"].append({"id": feature.id, "description": feature.description, "source": feature.source})
    return result


def save_owner(equipment_id, name, contact, actor_id, expected_before=None):
    require_role(actor_id, "manager")
    name, contact = name.strip(), contact.strip()
    if len(name) > 200 or len(contact) > 300 or (contact and not name):
        raise ValueError("Укажите владельца; контакт — до 300 символов")
    with Session.begin() as session:
        if not session.get(Equipment, equipment_id, with_for_update=True):
            raise ValueError("Экземпляр не найден")
        owner = session.get(EquipmentOwner, equipment_id)
        before = {"name": owner.name, "contact": owner.contact} if owner else {}
        if expected_before is not None and before != expected_before:
            from .rental import Conflict
            raise Conflict("Данные владельца изменились. Откройте карточку заново")
        if owner is None:
            owner = EquipmentOwner(equipment_id=equipment_id)
            session.add(owner)
        owner.name, owner.contact = name, contact
        session.add(InventoryAudit(equipment_id=equipment_id, actor_id=actor_id,
                                  action="owner_updated", detail={"before": before, "after": {"name": name, "contact": contact}}))


def save_feature(equipment_id, description, actor_id, feature_id=None, remove=False, source="catalog", expected_before=None):
    require_role(actor_id, "admin" if feature_id is not None else "operator")
    description = description.strip()
    if not remove and (not description or len(description) > 2000):
        raise ValueError("Опишите особенность, до 2000 символов")
    if source not in {"catalog", "found_on_return"}:
        raise ValueError("Неверный источник особенности")
    with Session.begin() as session:
        if not session.get(Equipment, equipment_id, with_for_update=True):
            raise ValueError("Экземпляр не найден")
        feature = session.get(EquipmentFeature, feature_id) if feature_id is not None else None
        if feature_id is not None and (not feature or feature.equipment_id != equipment_id or feature.deleted_at):
            raise ValueError("Особенность не найдена")
        before = feature.description if feature else ""
        if expected_before is not None and before != expected_before:
            from .rental import Conflict
            raise Conflict("Особенность изменилась. Откройте карточку заново")
        if feature is None:
            feature = EquipmentFeature(equipment_id=equipment_id, actor_id=actor_id, source=source)
            session.add(feature)
        if remove:
            feature.deleted_at = datetime.now(timezone.utc)
        else:
            feature.description = description
        session.flush()
        session.add(InventoryAudit(equipment_id=equipment_id, actor_id=actor_id,
            action="feature_deleted" if remove else "feature_edited" if feature_id else "feature_added",
            detail={"feature_id": feature.id, "before": before, "after": "" if remove else description, "source": source}))
        return feature.id
