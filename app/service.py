from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from .db import Audit, Booking, BookingItem, BookingOperationLease, Equipment, Occupancy, Session
from .rental import Conflict as RentalConflict, _claim_stage


class Conflict(Exception):
    pass


def now():
    return datetime.now(timezone.utc)


def validate_interval(start, end, enforce_booking_notice=False):
    if start.tzinfo is None or end.tzinfo is None or start >= end:
        raise ValueError("Укажите корректные дату и время начала и возврата")
    if enforce_booking_notice:
        moscow = ZoneInfo("Europe/Moscow")
        earliest_date = now().astimezone(moscow).date() + timedelta(days=4)
        if start.astimezone(moscow).date() < earliest_date:
            raise ValueError("Выдачу можно назначить не раньше чем через 4 календарных дня; дата сегодня + 3 дня недоступна")
    if start < now() - timedelta(minutes=1):
        raise ValueError("Начало аренды уже прошло")


def expire_holds(session):
    """Legacy entry point; pending bookings now wait for an operator decision."""


def availability(start, end):
    validate_interval(start, end)
    with Session.begin() as session:
        expire_holds(session)
        items = session.scalars(select(Equipment).order_by(Equipment.name, Equipment.inventory_number)).all()
        result = []
        for item in items:
            overlaps = session.scalars(select(Occupancy).where(Occupancy.equipment_id == item.id, Occupancy.starts_at < end, Occupancy.ends_at > start).order_by(Occupancy.ends_at)).all()
            upcoming = session.scalar(select(func.max(Occupancy.ends_at)).where(Occupancy.equipment_id == item.id, Occupancy.starts_at < end, Occupancy.ends_at > start))
            result.append({"id": item.id, "number": item.inventory_number, "name": item.name, "description": item.description, "image_url": item.image_url, "condition": item.condition, "available": item.condition == "available" and not overlaps, "next_free": upcoming, "busy_intervals": [{"start": occupancy.starts_at.isoformat(), "end": occupancy.ends_at.isoformat()} for occupancy in overlaps]})
        return result


def booking_total(start, end, rates):
    hours = Decimal(str((end - start).total_seconds())) / Decimal("3600")
    return (sum((Decimal(str(rate)) for rate in rates), Decimal("0")) * hours).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def create_booking(customer_id, customer_name, customer_contact, start, end, equipment_ids, request_id=None, expected_total=None):
    if request_id:
        previous = get_booking_by_request(customer_id, request_id)
        if previous:
            return previous
    validate_interval(start, end, enforce_booking_notice=True)
    ids = sorted(set(int(i) for i in equipment_ids))
    if not ids or not customer_name.strip() or not customer_contact.strip():
        raise ValueError("Нужны оборудование, имя и контакт клиента")
    try:
        with Session.begin() as session:
            if request_id:
                previous = session.scalar(select(Booking.id).where(Booking.customer_id == customer_id, Booking.client_request_id == request_id))
                if previous:
                    return previous
            for equipment_id in ids:
                session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": equipment_id})
            if request_id:
                previous = session.scalar(select(Booking.id).where(Booking.customer_id == customer_id, Booking.client_request_id == request_id))
                if previous:
                    return previous
            expire_holds(session)
            items = session.scalars(select(Equipment).where(Equipment.id.in_(ids))).all()
            if len(items) != len(ids) or any(item.condition != "available" for item in items):
                raise Conflict("Оборудование недоступно")
            booking = Booking(customer_id=customer_id, client_request_id=request_id, customer_name=customer_name.strip(), customer_contact=customer_contact.strip(), starts_at=start, ends_at=end, status="pending", hold_expires_at=None)
            session.add(booking)
            session.flush()
            for item in items:
                session.add(BookingItem(booking_id=booking.id, equipment_id=item.id, hourly_rate=Decimal("0")))
                session.add(Occupancy(booking_id=booking.id, equipment_id=item.id, starts_at=start, ends_at=end))
            session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="created"))
            session.flush()
            return booking.id
    except IntegrityError as exc:
        if request_id:
            with Session() as session:
                previous = session.scalar(select(Booking.id).where(Booking.customer_id == customer_id, Booking.client_request_id == request_id))
                if previous:
                    return previous
        raise Conflict("На выбранное время оборудование уже занято") from exc


TRANSITIONS = {"pending": {"confirmed", "cancelled"}, "confirmed": {"issued", "cancelled"}, "issued": {"returned"}}


def transition(booking_id, action, actor_id, customer_id=None):
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        if booking is None:
            raise ValueError("Заявка не найдена")
        if customer_id is not None and booking.customer_id != customer_id:
            raise ValueError("Заявка не найдена")
        if action not in TRANSITIONS.get(booking.status, set()):
            raise Conflict("Недопустимое изменение статуса")
        if customer_id is None:
            try:
                _claim_stage(session, booking, actor_id)
            except RentalConflict as exc:
                raise Conflict(str(exc)) from exc
        if action in {"cancelled", "returned"}:
            session.execute(delete(Occupancy).where(Occupancy.booking_id == booking.id))
        lease = session.get(BookingOperationLease, (booking.id, booking.status))
        if lease:
            session.delete(lease)
        booking.status = action
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action=action))
        return booking.status


def get_booking(booking_id):
    from sqlalchemy.orm import selectinload
    with Session() as session:
        return session.scalar(select(Booking).options(selectinload(Booking.items).selectinload(BookingItem.equipment)).where(Booking.id == booking_id))


def get_booking_by_request(customer_id, request_id):
    with Session() as session:
        return session.scalar(select(Booking.id).where(Booking.customer_id == customer_id, Booking.client_request_id == request_id))


def list_bookings():
    from sqlalchemy.orm import selectinload
    with Session.begin() as session:
        expire_holds(session)
        return session.scalars(select(Booking).options(selectinload(Booking.items).selectinload(BookingItem.equipment)).order_by(Booking.created_at.desc()).limit(200)).all()


def list_customer_bookings(customer_id):
    from sqlalchemy.orm import selectinload
    with Session.begin() as session:
        expire_holds(session)
        return session.scalars(select(Booking).options(selectinload(Booking.items).selectinload(BookingItem.equipment)).where(Booking.customer_id == customer_id).order_by(Booking.created_at.desc()).limit(50)).all()


def list_equipment():
    with Session() as session:
        return session.scalars(select(Equipment).order_by(Equipment.name, Equipment.inventory_number)).all()


def save_equipment(number, name, description, rate, condition, equipment_id=None, image_url=None):
    if condition not in {"available", "maintenance", "retired"} or Decimal(str(rate)) < 0:
        raise ValueError("Неверное состояние или ставка")
    if image_url and (len(image_url) > 500 or urlparse(image_url).scheme != "https" or not urlparse(image_url).netloc):
        raise ValueError("Ссылка на фото должна начинаться с HTTPS")
    with Session.begin() as session:
        if equipment_id:
            session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": equipment_id})
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
        if image_url is not None:
            item.image_url = image_url.strip()
        item.hourly_rate = Decimal(str(rate))
        item.condition = condition
        session.add(item)
        session.flush()
        return item.id


# Article-based implementation. These aliases keep existing bot/web imports working
# while the old functions above remain available for one migration cycle.
from .rental import (  # noqa: E402,F401
    Conflict, assign_booking_assets, availability, booking_total, create_booking,
    close_repair, delete_dependency, expire_holds, get_booking, get_booking_by_request,
    lines_total, list_articles, list_bookings, list_customer_bookings, list_dependencies,
    list_equipment, list_repairs, mark_act_signed, now, record_inspection, save_article,
    save_dependency, save_equipment, transition,
)
