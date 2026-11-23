"""Physical return deadlines and notifications for rentals still out."""
from datetime import datetime, time, timedelta, timezone
from html import escape

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert

from .db import Booking, BookingAsset, BookingHandover, BookingLine, Equipment, NotificationDelivery, Session, StaffRole
from .operator_preferences import next_actionable_time
from .roles import configured_ids
from .schedule import next_working_slot
from .sla_clock import MOSCOW


OUT_STATUSES = {"issued", "return_inspection"}
UPCOMING_STATUSES = {"confirmed", "preparing", "ready"}
CUSTOMER_EVENT = "return_overdue_customer"
OPERATOR_EVENT = "return_overdue_operator"
MANAGER_EVENT = "return_overdue_manager"
RISK_EVENT = "return_overdue_next_booking"
RETURN_EVENTS = {CUSTOMER_EVENT, OPERATOR_EVENT, MANAGER_EVENT}


def cancel_pending_return_notifications(session, booking_id, at):
    session.execute(update(NotificationDelivery).where(
        NotificationDelivery.booking_id == booking_id, NotificationDelivery.event.in_(RETURN_EVENTS),
        NotificationDelivery.sent_at.is_(None), NotificationDelivery.cancelled_at.is_(None),
    ).values(cancelled_at=at, next_retry_at=None))


def overdue(booking, handover, at=None):
    return (
        booking.status in OUT_STATUSES
        and booking.deleted_at is None
        and booking.ends_at <= (at or datetime.now(timezone.utc))
        and not (handover or {}).get("operator_return")
    )


def occupied_assets():
    return (
        select(Equipment.article_id, Equipment.id.label("equipment_id"), Booking.ends_at, Booking.id.label("booking_id"))
        .select_from(BookingAsset)
        .join(Booking, Booking.id == BookingAsset.booking_id)
        .join(Equipment, Equipment.id == BookingAsset.equipment_id)
        .where(BookingAsset.deleted_at.is_(None), Booking.status.in_(OUT_STATUSES),
               or_(Booking.deleted_at.is_(None), Booking.deletion_level == "L2"))
    )


def overdue_asset_query(at):
    return occupied_assets().where(Booking.ends_at <= at)


def at_risk(session, booking, at=None):
    at = at or datetime.now(timezone.utc)
    if booking.deleted_at is not None or booking.status not in UPCOMING_STATUSES or booking.ends_at <= at:
        return False
    held = overdue_asset_query(at).subquery()
    assigned = select(BookingAsset.equipment_id).where(
        BookingAsset.booking_id == booking.id, BookingAsset.deleted_at.is_(None))
    if session.scalar(select(held.c.equipment_id).where(held.c.equipment_id.in_(assigned)).limit(1)) is not None:
        return True
    from .rental import _capacity, _reserved_quantity
    demand = session.execute(select(BookingLine.article_id, func.sum(BookingLine.quantity))
        .where(BookingLine.booking_id == booking.id, BookingLine.deleted_at.is_(None),
               BookingLine.article_id.in_(select(held.c.article_id)))
        .group_by(BookingLine.article_id))
    start = max(booking.starts_at, at)
    for article_id, quantity in demand:
        capacity = _capacity(session, article_id)
        planned = _reserved_quantity(session, article_id, start, booking.ends_at, booking.id, include_overdue=False)
        if capacity - planned >= quantity and capacity - _reserved_quantity(
            session, article_id, start, booking.ends_at, booking.id, at=at
        ) < quantity:
            return True
    return False


def booking_at_risk(booking):
    with Session() as session:
        return at_risk(session, booking)


def _queue(session, booking, recipient, event, message, at, due, deadline):
    return session.scalar(insert(NotificationDelivery).values(
        booking_id=booking.id, recipient_id=recipient, event=event, message=message,
        created_at=at, next_retry_at=due, return_due_at=deadline,
    ).on_conflict_do_nothing(index_elements=["booking_id", "recipient_id", "event", "return_due_at"],
        index_where=text("return_due_at IS NOT NULL")).returning(NotificationDelivery.id)) is not None


def staff_route(session, booking):
    staff = dict(session.execute(select(StaffRole.telegram_id, StaffRole.role).where(
        StaffRole.telegram_id.in_(configured_ids("ADMIN_IDS")),
        StaffRole.role.in_({"operator", "manager", "admin"}))).all())
    managers = {uid for uid, role in staff.items() if role in {"manager", "admin"}}
    return {booking.assignee_id} if booking.assignee_id in staff else managers, managers


def _deadline_text(value):
    return value.astimezone(MOSCOW).strftime("%d.%m.%Y %H:%M МСК")


def queue_return_notifications(at=None, *, since=None):
    at = at or datetime.now(timezone.utc)
    held = overdue_asset_query(at).subquery()
    affected = or_(
        Booking.id.in_(select(BookingLine.booking_id).where(
            BookingLine.deleted_at.is_(None), BookingLine.article_id.in_(select(held.c.article_id)))),
        Booking.id.in_(select(BookingAsset.booking_id).where(
            BookingAsset.deleted_at.is_(None), BookingAsset.equipment_id.in_(select(held.c.equipment_id)))),
    )
    count = 0
    cursor = 0
    changed = False
    while True:
        with Session.begin() as session:
            bookings = session.scalars(select(Booking).where(
                Booking.id > cursor, Booking.deleted_at.is_(None), or_(
                    and_(Booking.status.in_(OUT_STATUSES), Booking.ends_at <= at),
                    and_(Booking.status.in_(UPCOMING_STATUSES), Booking.ends_at > at, affected),
                )).order_by(Booking.id).limit(100).with_for_update(skip_locked=True)).all()
            if not bookings:
                break
            cursor = bookings[-1].id
            for booking in bookings:
                number = escape(booking.human_number or str(booking.id))
                if booking.status in UPCOMING_STATUSES:
                    if at_risk(session, booking, at):
                        recipients, _ = staff_route(session, booking)
                        for uid in recipients:
                            count += _queue(session, booking, uid, RISK_EVENT,
                                f"Заявка {number}: риск срыва выдачи\nТехника задержалась на возврате. Проверьте комплект и подберите замену.",
                                at, next_actionable_time(uid, at), booking.starts_at)
                    continue
                handover = session.get(BookingHandover, booking.id)
                if not overdue(booking, handover.data if handover else {}, at):
                    continue
                deadline = booking.ends_at
                message = f"Заявка {number}: возврат просрочен\nСрок сдачи — {_deadline_text(deadline)}."
                created = _queue(session, booking, booking.customer_id, CUSTOMER_EVENT,
                    message + " Сдайте оборудование или свяжитесь с оператором.", at, at, deadline)
                count += created
                changed = changed or bool(created)
                recipients, managers = staff_route(session, booking)
                for uid in recipients:
                    count += _queue(session, booking, uid, OPERATOR_EVENT, message, at,
                        next_actionable_time(uid, at), deadline)
                tomorrow = deadline.astimezone(MOSCOW).date() + timedelta(days=1)
                if at >= next_working_slot(datetime.combine(tomorrow, time.min, MOSCOW)):
                    for uid in managers:
                        count += _queue(session, booking, uid, MANAGER_EVENT,
                            message + " Передача оборудования всё ещё не подтверждена. Свяжитесь с ответственным.",
                            at, next_actionable_time(uid, at), deadline)
    with Session.begin() as session:
        if since is not None and not changed:
            changed = session.execute(overdue_asset_query(at).where(Booking.ends_at > since).limit(1)).first() is not None
        if changed:
            if session.scalar(text("SELECT to_regclass('availability_cache_revision')")):
                session.execute(text("UPDATE availability_cache_revision SET revision = revision + 1 WHERE id = 1"))
            session.execute(text("SELECT pg_notify('polyrental_availability', 'changed')"))
    return count
