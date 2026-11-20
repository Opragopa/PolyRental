"""Shared customer guidance and acknowledged ready invitations (0.5.11)."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import select

from .db import Booking, BookingEvent, BookingEventRecipient, HandoverSettings, Session

ACTIVE = ("pending", "needs_changes", "confirmed", "preparing", "ready", "issued", "return_inspection")


def settings_view(session):
    row = session.get(HandoverSettings, 1)
    return {"pickup_location": row.pickup_location if row else "",
            "pickup_instructions": row.pickup_instructions if row else ""}


def get_settings():
    with Session() as session:
        return settings_view(session)


def save_settings(actor_id, location, instructions):
    from .inventory import require_role
    require_role(actor_id, "admin")
    location, instructions = location.strip(), instructions.strip()
    if len(location) > 500 or len(instructions) > 2000:
        raise ValueError("Адрес — до 500 символов, инструкция — до 2000")
    with Session.begin() as session:
        from sqlalchemy.dialects.postgresql import insert
        session.execute(insert(HandoverSettings).values(id=1, pickup_location=location,
            pickup_instructions=instructions, updated_by=actor_id).on_conflict_do_update(
            index_elements=[HandoverSettings.id], set_={"pickup_location": location,
            "pickup_instructions": instructions, "updated_by": actor_id, "updated_at": datetime.now(timezone.utc)}))
        return {"pickup_location": location, "pickup_instructions": instructions}


def next_action(booking, settings=None):
    settings = settings or {}
    action, label, title, description = "open", "Открыть заявку", "Заявка на проверке", "Дождитесь решения сотрудника."
    status, identity = booking.status, booking.identity_status
    if status == "needs_changes":
        title, label, description = "Нужно исправить заявку", "Посмотреть изменения", "Проверьте предложенные изменения в заявке."
    elif status in {"confirmed", "preparing", "ready"}:
        if identity in {"required", "needs_changes", "not_required", "deleted"}:
            action, label, title = "identity", "Заполнить анкету", "Нужна анкета для выдачи"
            if identity == "needs_changes": label, title = "Исправить анкету", "Исправьте данные анкеты"
            description = "Заполните защищённую анкету в приложении. Не отправляйте документы в чат."
        elif identity == "submitted":
            title, description = "Анкета на проверке", "Сотрудник проверяет документы. О готовности техники сообщим отдельно."
        elif identity == "blocked":
            action, label, title, description = "support", "Связаться с оператором", "Нужна помощь сотрудника", "Обратитесь к оператору по поводу анкеты."
        else:
            title, description = "Документы проверены", "Оборудование готовится к выдаче. Дождитесь уведомления о готовности."
            if status == "ready":
                if booking.ends_at <= datetime.now(timezone.utc):
                    action, label, title, description = "support", "Связаться с оператором", "Уточните получение", "Период заявки уже закончился. Согласуйте дальнейшие действия с сотрудником."
                else:
                    title = "Всё готово к выдаче"
                    when = booking.starts_at.astimezone(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y в %H:%M МСК")
                    description = f"Получение — {when}. Приходите в согласованное время."
    elif status == "issued":
        action, label, title = "return", "Сдать оборудование", "Оборудование у вас"
        description = "Когда будете передавать технику сотруднику, нажмите «Сдать оборудование»."
    elif status == "return_inspection":
        title, description = "Возврат на проверке", "Сотрудник проверяет оборудование. Повторно подтверждать сдачу не нужно."
    elif status == "returned":
        title, description = "Аренда завершена", "Сотрудник принял оборудование. Расписка и история остаются в заявке."
    elif status == "cancelled":
        title, description = "Заявка отменена", "Оборудование по этой заявке не ожидает выдачи."
    elif status == "expired":
        title, description = "Срок заявки истёк", "Откройте заявку или свяжитесь с сотрудником."
    return {"booking_id": booking.id, "human_number": booking.human_number or str(booking.id),
            "status": status, "identity_status": identity, "starts_at": booking.starts_at.isoformat(),
            "ends_at": booking.ends_at.isoformat(), "action": action, "label": label,
            "title": title, "description": description,
            "pickup_location": settings.get("pickup_location", "") if status == "ready" else "",
            "pickup_instructions": settings.get("pickup_instructions", "") if status == "ready" else ""}


def next_actions(user_id):
    with Session() as session:
        settings = settings_view(session)
        bookings = session.scalars(select(Booking).where(Booking.customer_id == user_id,
            Booking.deleted_at.is_(None), Booking.status.in_(ACTIVE))).all()
        items = []
        for booking in bookings:
            item = next_action(booking, settings)
            item["equipment"] = [{"name": line.article.name, "quantity": line.quantity} for line in booking.lines if line.deleted_at is None]
            items.append(item)
    priority = {"issued": 0, "ready": 1, "needs_changes": 2}
    items.sort(key=lambda item: (priority.get(item["status"], 3 if item["action"] == "identity" else 4),
                               item["ends_at"] if item["status"] == "issued" else item["starts_at"], item["booking_id"]))
    return items


def pending_ready(user_id):
    with Session() as session:
        settings = settings_view(session)
        rows = session.execute(select(BookingEventRecipient, BookingEvent, Booking).join(
            BookingEvent, BookingEvent.id == BookingEventRecipient.event_id).join(
            Booking, Booking.id == BookingEvent.booking_id).where(
            BookingEventRecipient.recipient_id == user_id, Booking.customer_id == user_id,
            Booking.deleted_at.is_(None), Booking.status == "ready", Booking.identity_status == "verified",
            BookingEvent.actions.contains(["ready"])).order_by(BookingEvent.version.desc())).all()
        seen, result = set(), []
        for receipt, event, booking in rows:
            if booking.id in seen: continue
            seen.add(booking.id)
            if receipt.shown_at is None and booking.ends_at > datetime.now(timezone.utc):
                result.append({"event_id": event.id, **next_action(booking, settings)})
        return result


def acknowledge_ready(user_id, event_id):
    with Session.begin() as session:
        row = session.execute(select(BookingEventRecipient).join(BookingEvent).join(
            Booking, Booking.id == BookingEvent.booking_id).where(
            BookingEventRecipient.recipient_id == user_id, BookingEventRecipient.event_id == event_id,
            Booking.customer_id == user_id, BookingEvent.actions.contains(["ready"])
            ).with_for_update(of=BookingEventRecipient)).scalar_one_or_none()
        if row is None: raise ValueError("Уведомление не найдено")
        if row.shown_at is None: row.shown_at = datetime.now(timezone.utc)


def public_features(booking_id):
    from .db import BookingHandover, BookingAsset, Equipment
    from .inventory import inventory_details
    with Session() as session:
        handover = session.get(BookingHandover, booking_id)
        if handover and handover.data.get("snapshot"):
            return [{"name": item.get("name", "Оборудование"), "features": item.get("features", []),
                     "components": item.get("components", [])} for item in handover.data["snapshot"]]
        assets = session.scalars(select(Equipment).join(BookingAsset, BookingAsset.equipment_id == Equipment.id).where(
            BookingAsset.booking_id == booking_id, BookingAsset.deleted_at.is_(None))).all()
        return [{"name": asset.article.name, "features": inventory_details(asset.id, session)["features"]} for asset in assets]


def customer_keyboard(booking, recipient_id):
    """Buttons always reflect the current owned booking, never a stale event."""
    if not booking or booking.customer_id != recipient_id or booking.deleted_at: return None
    import os
    from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
    from .booking_events import booking_link
    action = next_action(booking)
    rows = []
    if action["action"] == "return":
        rows.append([InlineKeyboardButton(text="Сдать оборудование", callback_data=f"cw:askattest:{booking.id}:returning")])
    base = os.getenv("PUBLIC_URL", "").rstrip("/")
    key = "identity" if action["action"] == "identity" else "booking"
    if base.startswith("https://"):
        rows.append([InlineKeyboardButton(text=action["label"] if key == "identity" else "Открыть заявку", web_app=WebAppInfo(url=f"{base}/miniapp?{key}={booking.id}"))])
    else:
        rows.append([InlineKeyboardButton(text="Открыть заявку", url=booking_link(booking.id))])
    if booking.status == "ready" or action["action"] == "support":
        rows.append([InlineKeyboardButton(text="Связаться с оператором", callback_data=f"cw:support:{booking.id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows)
