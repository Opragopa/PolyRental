from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from .db import Audit, Booking, BookingItem, Equipment, Occupancy, Session


class Conflict(Exception):
    pass


def now():
    return datetime.now(timezone.utc)


def validate_interval(start, end):
    if start.tzinfo is None or end.tzinfo is None or start >= end:
        raise ValueError("Укажите корректные дату и время начала и возврата")
    if start < now() - timedelta(minutes=1):
        raise ValueError("Начало аренды уже прошло")


def expire_holds(session):
    expired = session.scalars(select(Booking).where(Booking.status == "pending", Booking.hold_expires_at <= now()).with_for_update()).all()
    for booking in expired:
        session.execute(delete(Occupancy).where(Occupancy.booking_id == booking.id))
        booking.status = "expired"
        session.add(Audit(booking_id=booking.id, actor_id=0, action="expired"))


def availability(start, end):
    validate_interval(start, end)
    with Session.begin() as session:
        expire_holds(session)
        items = session.scalars(select(Equipment).order_by(Equipment.name, Equipment.inventory_number)).all()
        result = []
        for item in items:
            overlaps = session.scalars(select(Occupancy).where(Occupancy.equipment_id == item.id, Occupancy.starts_at < end, Occupancy.ends_at > start).order_by(Occupancy.ends_at)).all()
            upcoming = session.scalar(select(func.max(Occupancy.ends_at)).where(Occupancy.equipment_id == item.id, Occupancy.starts_at < end, Occupancy.ends_at > start))
            result.append({"id": item.id, "number": item.inventory_number, "name": item.name, "rate": str(item.hourly_rate), "condition": item.condition, "available": item.condition == "available" and not overlaps, "next_free": upcoming})
        return result


def create_booking(customer_id, customer_name, customer_contact, start, end, equipment_ids):
    validate_interval(start, end)
    ids = sorted(set(int(i) for i in equipment_ids))
    if not ids or not customer_name.strip() or not customer_contact.strip():
        raise ValueError("Нужны оборудование, имя и контакт клиента")
    try:
        with Session.begin() as session:
            for equipment_id in ids:
                session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": equipment_id})
            expire_holds(session)
            items = session.scalars(select(Equipment).where(Equipment.id.in_(ids))).all()
            if len(items) != len(ids) or any(item.condition != "available" for item in items):
                raise Conflict("Оборудование недоступно")
            booking = Booking(customer_id=customer_id, customer_name=customer_name.strip(), customer_contact=customer_contact.strip(), starts_at=start, ends_at=end, status="pending", hold_expires_at=now() + timedelta(minutes=30))
            session.add(booking)
            session.flush()
            for item in items:
                session.add(BookingItem(booking_id=booking.id, equipment_id=item.id, hourly_rate=item.hourly_rate))
                session.add(Occupancy(booking_id=booking.id, equipment_id=item.id, starts_at=start, ends_at=end))
            session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="created"))
            session.flush()
            return booking.id
    except IntegrityError as exc:
        raise Conflict("На выбранное время оборудование уже занято") from exc


TRANSITIONS = {"pending": {"confirmed", "cancelled"}, "confirmed": {"issued", "cancelled"}, "issued": {"returned"}}


def transition(booking_id, action, actor_id):
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        if booking is None:
            raise ValueError("Заявка не найдена")
        if booking.status == "pending" and booking.hold_expires_at <= now():
            session.execute(delete(Occupancy).where(Occupancy.booking_id == booking.id))
            booking.status = "expired"
            session.add(Audit(booking_id=booking.id, actor_id=0, action="expired"))
            return "expired"
        if action not in TRANSITIONS.get(booking.status, set()):
            raise Conflict("Недопустимое изменение статуса")
        if action in {"cancelled", "returned"}:
            session.execute(delete(Occupancy).where(Occupancy.booking_id == booking.id))
        booking.status = action
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action=action))
        return booking.status


def get_booking(booking_id):
    from sqlalchemy.orm import selectinload
    with Session() as session:
        return session.scalar(select(Booking).options(selectinload(Booking.items).selectinload(BookingItem.equipment)).where(Booking.id == booking_id))


def list_bookings():
    from sqlalchemy.orm import selectinload
    with Session.begin() as session:
        expire_holds(session)
        return session.scalars(select(Booking).options(selectinload(Booking.items).selectinload(BookingItem.equipment)).order_by(Booking.created_at.desc()).limit(200)).all()


def list_equipment():
    with Session() as session:
        return session.scalars(select(Equipment).order_by(Equipment.name, Equipment.inventory_number)).all()


def save_equipment(number, name, description, rate, condition, equipment_id=None):
    if condition not in {"available", "maintenance", "retired"} or Decimal(str(rate)) < 0:
        raise ValueError("Неверное состояние или ставка")
    with Session.begin() as session:
        item = session.get(Equipment, equipment_id) if equipment_id else Equipment()
        if item is None:
            raise ValueError("Экземпляр не найден")
        if equipment_id and condition != "available":
            active = session.scalar(select(func.count()).select_from(Occupancy).where(Occupancy.equipment_id == equipment_id))
            if active:
                raise Conflict("Сначала завершите или отмените действующие брони")
        item.inventory_number = number.strip()
        item.name = name.strip()
        item.description = description.strip()
        item.hourly_rate = Decimal(str(rate))
        item.condition = condition
        session.add(item)
        session.flush()
        return item.id
