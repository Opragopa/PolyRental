"""One transactional event per booking command, shared by all entry points."""
from datetime import datetime, timezone
from html import escape
import os
from uuid import uuid4
from zoneinfo import ZoneInfo
from sqlalchemy import event, inspect, select, delete

ACTION_LABELS = {
    "customer_change_requested": "Клиент запросил изменения. Требуется решение оператора",
    "customer_change_approved": "Запрос клиента одобрен. Заявка открыта для исправления и повторного подтверждения",
    "customer_change_rejected": "Запрос клиента на изменения отклонён. Заявка остаётся подтверждённой",
    "created": "Заявка создана", "confirmed": "Заявка подтверждена",
    "preparing": "Начата подготовка", "ready": "Готово к выдаче",
    "issued": "Оборудование выдано", "return_inspection": "Начата приёмка",
    "returned": "Заявка завершена", "cancelled": "Заявка отменена",
    "request_rejected": "Заявка отклонена", "request_changes_proposed": "Предложены изменения заявки",
    "request_changes_disputed": "Изменения оспорены клиентом", "request_updated": "Заявка изменена",
    "request_changes_unanswered": "Истёк срок ответа на изменения",
    "returned_for_rework": "Заявка возвращена на доработку", "contact_updated": "Контакт обновлён",
    "customer_received": "Клиент подтвердил получение", "customer_returning": "Клиент подтвердил сдачу",
    "paper_issue_signed": "Отмечена подпись при выдаче", "paper_return_signed": "Отмечена подпись при возврате",
    "inspection_saved": "Сохранена проверка оборудования", "composition_updated": "Изменена комплектация",
    "request_deleted": "Заявка удалена", "request_restored": "Заявка восстановлена",
    "line_deleted": "Удалена позиция заявки", "asset_deleted": "Удалён экземпляр из заявки",
    "line_restored": "Восстановлена позиция", "asset_restored": "Восстановлен экземпляр",
    "return_finding_existing": "Отмечена особенность при возврате",
    "return_finding_damage": "Зафиксировано повреждение", "return_finding_lost": "Зафиксирована утеря",
    "legacy_receipt_migrated": "Подготовлена расписка старой выдачи",
    "identity_submitted": "Анкета отправлена на проверку", "identity_verified": "Анкета проверена",
    "identity_changes_requested": "Запрошены исправления анкеты", "identity_blocked": "Анкета заблокирована",
    "identity_unblocked": "Анкета разблокирована", "identity_manual_delete": "Анкета удалена",
}


def action_label(action):
    if action.startswith("assignee:"):
        return "Назначен ответственный сотрудник"
    return ACTION_LABELS.get(action.split(":")[0], "Заявка обновлена")


def booking_link(booking_id):
    # The Mini App already accepts request links via startapp.
    username = os.getenv("BOT_USERNAME", "").lstrip("@")
    if username:
        return f"https://t.me/{username}?startapp=booking_{booking_id}"
    return os.getenv("PUBLIC_URL", "").rstrip("/") + f"/miniapp?booking={booking_id}"


def render_card(session, booking):
    from .db import BookingLine, Article
    from .catalog_titles import catalog_title
    from .booking_messages import STATUS_LABELS
    from .user_names import user_name
    lines = session.execute(select(Article, BookingLine.quantity).join(BookingLine).where(
        BookingLine.booking_id == booking.id, BookingLine.deleted_at.is_(None)).order_by(BookingLine.id)).all()
    local = ZoneInfo("Europe/Moscow")
    period = f"{booking.starts_at.astimezone(local):%d.%m.%Y %H:%M} — {booking.ends_at.astimezone(local):%d.%m.%Y %H:%M} МСК"
    items = ""
    for index, (article, quantity) in enumerate(lines):
        name = catalog_title(article.name, article.kind, article.brand, article.key_spec)
        line = f"• {escape(name[:100])} — {quantity} шт.\n"
        if len(items) + len(line) > 2800:
            items += f"… ещё позиций: {len(lines) - index}"
            break
        items += line
    status = "Заявка удалена" if booking.deleted_at else STATUS_LABELS.get(booking.status, booking.status)
    return (f"<b>Заявка {escape(booking.human_number or str(booking.id))}</b>\n"
            f"Создана: {booking.created_at.astimezone(local):%d.%m.%Y %H:%M} МСК\n"
            f"Кем: {escape(user_name(session, booking.customer_id, fallback='Пользователь', saved=booking.customer_name)[:160])}\n"
            f"Статус: {escape(status)}\n{period}\n{items}\n"
            f'<a href="{escape(booking_link(booking.id), quote=True)}">Открыть заявку</a>')


def install_booking_events(factory):
    from .db import (Audit, PIIAudit, Booking, Inspection, NotificationDelivery, BookingEvent,
                     BookingEventRecipient, StaffRole, OperatorNotificationPreference)

    @event.listens_for(factory, "before_flush")
    def collect(session, *_):
        if session.info.get("writing_booking_events"):
            return
        pending = session.info.setdefault("booking_event_commands", {})
        session.info.setdefault("legacy_booking_deliveries", []).extend(
            row for row in session.new if isinstance(row, NotificationDelivery) and row.booking_id and not row.event_id)
        for row in list(session.dirty):
            if isinstance(row, Booking):
                old = inspect(row).attrs.assignee_id.history.deleted
                if old and old[0]:
                    session.info.setdefault("booking_previous_assignees", {}).setdefault(row.id, set()).add(old[0])
        for row in list(session.new) + list(session.dirty):
            action = None
            if isinstance(row, Audit):
                base = row.action.split(":")[0]
                if row.action.startswith("assignee:") or base in ACTION_LABELS:
                    action = row.action
            elif isinstance(row, PIIAudit) and f"identity_{row.action}" in ACTION_LABELS:
                action = f"identity_{row.action}"
            elif isinstance(row, Inspection):
                fields = ("result", "checklist", "notes", "defect", "charge_customer", "estimated_cost", "photo_sha256")
                if row in session.new or any(inspect(row).attrs[name].history.has_changes() for name in fields):
                    action = "inspection_saved"
            if action and row.booking_id:
                command = pending.setdefault(row.booking_id, {"actor": row.actor_id, "actions": []})
                command["actor"] = row.actor_id
                if action not in command["actions"]:
                    command["actions"].append(action)

    @event.listens_for(factory, "before_commit")
    def publish(session):
        session.flush()
        commands = session.info.pop("booking_event_commands", {})
        previous = session.info.pop("booking_previous_assignees", {})
        if not commands:
            return
        session.info["writing_booking_events"] = True
        try:
            from .roles import configured_ids
            from .operator_preferences import next_actionable_time
            staff = set(session.scalars(select(StaffRole.telegram_id).where(StaffRole.role.in_(["operator", "manager", "admin"])))) & set(configured_ids("ADMIN_IDS"))
            timestamp = datetime.now(timezone.utc)
            for booking_id, command in commands.items():
                booking = session.get(Booking, booking_id)
                if booking is None or booking in session.deleted:
                    continue
                # Retire the earlier per-handler pushes written in this command.
                legacy_ids = [row.id for row in session.info.get("legacy_booking_deliveries", [])
                    if row.booking_id == booking_id and (row.event.startswith("status_") or row.event in {
                        "booking_completed_operator", "request_rejected", "request_changes_proposed", "request_updated",
                        "request_changes_disputed", "returned_for_rework", "customer_returning_operator",
                        "request_changes", "request_disputed", "request_changes_answered", "request_unanswered"})]
                if legacy_ids:
                    session.execute(delete(NotificationDelivery).where(NotificationDelivery.id.in_(legacy_ids)))
                actor, actions = command["actor"], command["actions"]
                event_id = uuid4().hex
                session.add(BookingEvent(id=event_id, booking_id=booking_id, actor_id=actor,
                    actions=actions, status=booking.status, card_text=render_card(session, booking)))
                session.flush()
                responsible = ({booking.assignee_id} if booking.assignee_id else previous.get(booking_id, set()) or staff)
                recipients = {booking.customer_id, *responsible, *previous.get(booking_id, set())}
                if actor == booking.customer_id or actor in staff:
                    recipients.add(actor)
                # A former participant's existing card must not keep saying
                # "pending" forever; only actionable pushes follow ownership.
                previous_cards = set(session.scalars(select(NotificationDelivery.recipient_id).where(
                    NotificationDelivery.booking_id == booking_id, NotificationDelivery.delivery_kind == "card").distinct()))
                card_recipients = recipients | (previous_cards & (staff | {booking.customer_id}))
                number = escape(booking.human_number or str(booking_id))
                from .user_names import user_name
                author = escape(user_name(session, actor, fallback="Пользователь",
                                         saved=booking.customer_name if actor == booking.customer_id else ""))
                description = "; ".join(dict.fromkeys(action_label(action) for action in actions))
                details = session.info.get("booking_change_details", {}).get(booking_id)
                if details and (details["lines"] or details["dates"]):
                    changed = []
                    if details["lines"]:
                        changed.append(f"состав ({len(details['lines'])} поз.)")
                    if details["dates"]:
                        changed.append("сроки")
                    description += ". Изменены: " + ", ".join(changed)
                message = f'<b>Заявка {number}</b>\n{escape(description)}\nАвтор: {author}\n<a href="{escape(booking_link(booking_id), quote=True)}">Открыть заявку</a>'
                for recipient in card_recipients:
                    if recipient in recipients:
                        session.add(BookingEventRecipient(event_id=event_id, recipient_id=recipient,
                            shown_at=timestamp if recipient == actor else None))
                    preference = session.get(OperatorNotificationPreference, recipient) if recipient in staff else None
                    due = next_actionable_time(recipient, timestamp, {"quiet_start": preference.quiet_start, "quiet_end": preference.quiet_end}) if preference and preference.quiet_start else timestamp
                    for kind in ("card", "push") if recipient in recipients and recipient != actor else ("card",):
                        session.add(NotificationDelivery(booking_id=booking_id, recipient_id=recipient,
                            event="booking_update", event_id=event_id, delivery_kind=kind,
                            message=message, next_retry_at=due))
            session.flush()
        finally:
            session.info.pop("writing_booking_events", None)

    @event.listens_for(factory, "after_transaction_end")
    def clear(session, transaction):
        if transaction.parent is None:
            for key in ("booking_event_commands", "booking_previous_assignees", "writing_booking_events", "legacy_booking_deliveries", "booking_change_details"):
                session.info.pop(key, None)


def claim_notices(user_id):
    from .db import Session, BookingEvent, BookingEventRecipient
    with Session.begin() as session:
        rows = session.execute(select(BookingEventRecipient, BookingEvent).join(BookingEvent).where(
            BookingEventRecipient.recipient_id == user_id, BookingEventRecipient.shown_at.is_(None))
            .order_by(BookingEvent.version).limit(50)
            .with_for_update(of=BookingEventRecipient, skip_locked=True)).all()
        result = []
        for receipt, update in rows:
            receipt.shown_at = datetime.now(timezone.utc)
            result.append({"id": update.id, "booking_id": update.booking_id, "status": update.status,
                           "message": "; ".join(dict.fromkeys(action_label(action) for action in update.actions))})
        return result
