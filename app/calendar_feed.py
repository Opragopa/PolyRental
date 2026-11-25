"""Render rental events for the shared calendar subscription."""

from collections import Counter

from icalendar import Calendar, Event
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from .contact_input import normalize_contact
from .db import Booking, BookingItem, BookingLine, CatalogCategory, ClientProfile, Equipment, Session
from .user_names import normalize_telegram_username


CALENDAR_STATUSES = ("confirmed", "preparing", "ready", "issued", "return_inspection")


def _legacy_equipment(session, bookings):
    booking_ids = [booking.id for booking, _, _ in bookings if not booking.lines]
    if not booking_ids:
        return {}
    has_lines = select(BookingLine.id).where(BookingLine.booking_id == BookingItem.booking_id).exists()
    rows = session.scalars(
        select(BookingItem).where(BookingItem.booking_id.in_(booking_ids), ~has_lines)
        .options(selectinload(BookingItem.equipment).selectinload(Equipment.article))
        .order_by(BookingItem.booking_id, BookingItem.equipment_id)
    )
    equipment = {}
    for item in rows:
        asset = item.equipment
        model = (asset.article.name, asset.article.category) if asset.article else (asset.name, "")
        equipment.setdefault(item.booking_id, Counter())[model] += 1
    return equipment


def calendar_bytes():
    calendar = Calendar()
    calendar.add("prodid", "-//PolyRental//Calendar//RU")
    calendar.add("version", "2.0")
    with Session() as session:
        bookings = session.execute(
            select(Booking, ClientProfile.telegram_username, ClientProfile.display_name)
            .outerjoin(ClientProfile, ClientProfile.telegram_id == Booking.customer_id)
            .where(Booking.deleted_at.is_(None), Booking.status.in_(CALENDAR_STATUSES))
            .options(selectinload(Booking.lines).selectinload(BookingLine.article))
            .order_by(Booking.created_at.desc(), Booking.id.desc())
        ).all()
        if not bookings:
            return calendar.to_ical()
        categories = dict(session.execute(select(CatalogCategory.code, CatalogCategory.name)).all())
        legacy_equipment = _legacy_equipment(session, bookings)
        for booking, username, display_name in bookings:
            handle = username
            if not handle and display_name and display_name.startswith("@"):
                handle = normalize_telegram_username(display_name)
            if not handle:
                contact = normalize_contact(booking.customer_contact or "")
                if contact.startswith("@") or (len(contact) >= 5 and not contact.startswith("_")):
                    handle = normalize_telegram_username(contact)
            customer = f"@{handle}" if handle else "Клиент без ника"

            equipment = [(line.article.name, line.article.category, line.quantity)
                         for line in sorted(booking.lines, key=lambda line: line.id)]
            if not equipment:
                equipment = [(name, code, quantity)
                             for (name, code), quantity in legacy_equipment.get(booking.id, {}).items()]
            category_names = list(dict.fromkeys(categories.get(code, "Оборудование") for _, code, _ in equipment))

            event = Event()
            event.add("uid", f"booking-{booking.id}@polyrental")
            event.add("summary", f"{customer}. {', '.join(category_names) or 'Оборудование'}")
            event.add("description", "\n".join(f"• {name} × {quantity}" for name, _, quantity in equipment)
                      or "Список оборудования пуст")
            event.add("dtstamp", booking.created_at)
            event.add("dtstart", booking.starts_at)
            event.add("dtend", booking.ends_at)
            calendar.add_component(event)
    return calendar.to_ical()
