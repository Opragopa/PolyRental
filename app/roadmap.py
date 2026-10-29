"""Timed external use, optional reminders and cross-device staff navigation."""
from datetime import datetime, timedelta, timezone
from html import escape
from types import SimpleNamespace

from sqlalchemy import select, and_

from .db import (Booking, BookingReminder, ClientProfile, Equipment, EquipmentBlock,
                 InventoryAudit, NotificationDelivery, Session, StaffNavigation)
from .inventory import require_role
from .rental import Conflict, _asset_conflicts, _capacity, _reserved_quantity


def save_external_block(equipment_id, start, end, reason, actor_id):
    require_role(actor_id, "manager")
    if start.tzinfo is None or end.tzinfo is None or start >= end or not reason.strip() or len(reason) > 2000:
        raise ValueError("Укажите срок занятости и причину до 2000 символов")
    from sqlalchemy import text
    with Session.begin() as session:
        asset = session.get(Equipment, equipment_id)
        if not asset or asset.condition != "available":
            raise ValueError("Экземпляр недоступен")
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id":asset.article_id})
        article_id=asset.article_id
        if session.scalar(select(Equipment.id).where(Equipment.id==equipment_id)) is None:
            raise Conflict("Экземпляр удалён; обновите каталог")
        session.refresh(asset,with_for_update=True)
        if asset.article_id!=article_id or asset.condition!="available":
            raise Conflict("Карточка экземпляра изменилась; повторите проверку")
        if _asset_conflicts(session, SimpleNamespace(id=0, starts_at=start, ends_at=end), equipment_id):
            raise Conflict("Экземпляр уже занят в этот период")
        if _capacity(session,asset.article_id) - _reserved_quantity(session,asset.article_id,start,end) < 1:
            raise Conflict("На этот период уже подтверждены заявки")
        row = EquipmentBlock(equipment_id=equipment_id,starts_at=start,ends_at=end,reason=reason.strip(),actor_id=actor_id)
        session.add(row); session.flush()
        session.add(InventoryAudit(equipment_id=equipment_id,actor_id=actor_id,action="external_block_created",
                                  detail={"block_id":row.id,"start":start.isoformat(),"end":end.isoformat(),"reason":reason.strip()}))
        return row.id


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
