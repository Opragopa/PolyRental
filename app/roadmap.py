"""Timed external use, optional reminders and cross-device staff navigation."""
from datetime import datetime, timedelta, timezone
from html import escape

from sqlalchemy import select, and_, or_

from .db import (Booking, BookingAsset, BookingLine, BookingReminder, ClientProfile, Equipment, EquipmentBlock,
                 InventoryAudit, NotificationDelivery, Session, StaffNavigation)
from .inventory import require_role
from .rental import Conflict, RESERVING_STATUSES


def save_external_block(equipment_id, start, end, reason, actor_id, with_warnings=False):
    require_role(actor_id, "manager")
    if start.tzinfo is None or end.tzinfo is None or start >= end or not reason.strip() or len(reason) > 2000:
        raise ValueError("Укажите срок занятости и причину до 2000 символов")
    from sqlalchemy import text
    with Session.begin() as session:
        asset = session.get(Equipment, equipment_id)
        if not asset:
            raise ValueError("Экземпляр не найден")
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id":asset.article_id})
        article_id=asset.article_id
        if session.scalar(select(Equipment.id).where(Equipment.id==equipment_id)) is None:
            raise Conflict("Экземпляр удалён; обновите каталог")
        session.refresh(asset,with_for_update=True)
        if asset.article_id!=article_id:
            raise Conflict("Карточка экземпляра изменилась; повторите проверку")
        warnings = [item for item in external_schedule(equipment_id, session) if
            datetime.fromisoformat(item["start"]) < end
            and (item["end"] is None or datetime.fromisoformat(item["end"]) > start)] if with_warnings else []
        row = EquipmentBlock(equipment_id=equipment_id,starts_at=start,ends_at=end,reason=reason.strip(),actor_id=actor_id)
        session.add(row); session.flush()
        session.add(InventoryAudit(equipment_id=equipment_id,actor_id=actor_id,action="external_block_created",
                                  detail={"block_id":row.id,"start":start.isoformat(),"end":end.isoformat(),"reason":reason.strip()}))
        return {"id": row.id, "warnings": warnings} if with_warnings else row.id


def release_external_block(block_id, actor_id):
    require_role(actor_id,"manager")
    from sqlalchemy import text
    with Session.begin() as session:
        row = session.get(EquipmentBlock,block_id,with_for_update=True)
        if row is None: raise ValueError("Занятость не найдена")
        asset = session.get(Equipment,row.equipment_id)
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id":asset.article_id})
        if row.released_at: return
        row.released_at = datetime.now(timezone.utc)
        session.add(InventoryAudit(equipment_id=row.equipment_id,actor_id=actor_id,action="external_block_released",detail={"block_id":row.id}))


def external_blocks(equipment_id):
    with Session() as session:
        return [{"id":row.id,"start":row.starts_at.isoformat(),"end":row.ends_at.isoformat(),"reason":row.reason}
                for row in session.scalars(select(EquipmentBlock).where(EquipmentBlock.equipment_id==equipment_id,
                    EquipmentBlock.released_at.is_(None),EquipmentBlock.ends_at>datetime.now(timezone.utc)).order_by(EquipmentBlock.starts_at))]


def external_schedule(equipment_id, session=None):
    """Busy intervals for staff warnings; never expose customer details."""
    if session is None:
        with Session() as current:
            return external_schedule(equipment_id, current)
    asset = session.get(Equipment, equipment_id)
    if not asset:
        raise ValueError("Экземпляр не найден")
    current = datetime.now(timezone.utc)
    items = [{"id": row.id, "kind": "external", "start": row.starts_at.isoformat(),
              "end": row.ends_at.isoformat(), "label": "Занятость вне сервиса", "reason": row.reason}
             for row in session.scalars(select(EquipmentBlock).where(
                 EquipmentBlock.equipment_id == equipment_id, EquipmentBlock.released_at.is_(None)))]
    assigned = select(BookingAsset.equipment_id).where(BookingAsset.booking_id == Booking.id,
        BookingAsset.equipment_id == equipment_id, BookingAsset.deleted_at.is_(None)).exists()
    article_line = select(BookingLine.id).where(BookingLine.booking_id == Booking.id,
        BookingLine.article_id == asset.article_id, BookingLine.deleted_at.is_(None)).exists()
    article_assigned = select(BookingAsset.equipment_id).join(Equipment, Equipment.id == BookingAsset.equipment_id).where(
        BookingAsset.booking_id == Booking.id, Equipment.article_id == asset.article_id,
        BookingAsset.deleted_at.is_(None)).exists()
    for booking, is_assigned in session.execute(select(Booking, assigned).where(Booking.status.in_(RESERVING_STATUSES),
            or_(Booking.deleted_at.is_(None), Booking.deletion_level == "L2"),
            or_(assigned, and_(article_line, ~article_assigned)))):
        overdue = booking.status in {"issued", "return_inspection"} and booking.ends_at <= current
        items.append({"id": booking.id, "kind": "booking", "start": booking.starts_at.isoformat(),
            "end": booking.ends_at.isoformat(),
            "label": f"Заявка {booking.human_number or booking.id}",
            "reason": "Плановый возврат просрочен; проверьте возврат" if overdue else "Бронь модели; экземпляр ещё не назначен" if not is_assigned else "Экземпляр назначен на заявку"})
    return sorted(items, key=lambda item: item["start"])

def save_staff_section(actor_id, section):
    require_role(actor_id, "admin" if section == "hidden_tests" else "operator")
    if section not in {"orders","catalog","repairs","support","hidden_tests"}:
        raise ValueError("Неизвестный раздел")
    with Session.begin() as session:
        row = session.get(StaffNavigation,actor_id)
        if row is None:
            row=StaffNavigation(telegram_id=actor_id); session.add(row)
        row.section=section


def queue_optional_reminders(at=None):
    timestamp=at or datetime.now(timezone.utc)
    count=0
    from .booking_changes import queue
    with Session.begin() as session:
        ids=session.scalars(select(Booking.id).where(Booking.deleted_at.is_(None),
            Booking.status.in_({"confirmed","preparing","ready","issued","return_inspection"})).order_by(Booking.id)).all()
        for booking_id in ids:
            booking=session.get(Booking,booking_id,with_for_update=True)
            if booking.deleted_at or booking.status not in {"confirmed","preparing","ready","issued","return_inspection"}: continue
            profile=session.get(ClientProfile,booking.customer_id,with_for_update=True)
            if profile and not profile.reminders_enabled: continue
            if booking.status=="return_inspection": continue
            returning=booking.status=="issued"
            moment=booking.ends_at if returning else booking.starts_at
            remaining=moment-timestamp
            if not timedelta(0)<remaining<=timedelta(hours=24): continue
            tier=2 if remaining<=timedelta(hours=2) else 24
            event=f"optional_reminder_{'return' if returning else 'issue'}_{tier}h"
            if session.get(BookingReminder,(booking_id,event)): continue
            session.add(BookingReminder(booking_id=booking_id,event=event))
            queue(session,booking,event,f"Напоминание по заявке {escape(booking.human_number or str(booking.id))}: {'возврат' if returning else 'выдача'} оборудования менее чем через {tier} ч. Сроки доступны в Mini App.")
            count+=1
    return count
