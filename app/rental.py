"""Article-based rental, preparation, inspection and return workflows."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from urllib.parse import urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from .db import (Article, ArticleDependency, Audit, Booking, BookingAsset, BookingDeletionAudit, BookingDocument,
                 BookingItem, BookingLine,
                 CustomerIdentity, Equipment, IdentityDocument, Inspection, Occupancy, PIIAudit,
                 PrivacyConsent, RepairTicket, Session)


class Conflict(Exception):
    pass


ACTIVE_STATUSES = {"pending", "confirmed", "preparing", "ready", "issued", "return_inspection"}


def now():
    return datetime.now(timezone.utc)


def validated_rate(value):
    try:
        rate = Decimal(str(value))
        if not rate.is_finite() or rate < 0 or rate > Decimal("9999999999.99") or rate.as_tuple().exponent < -2:
            raise ValueError("Укажите неотрицательную ставку с точностью до копеек")
        return rate
    except InvalidOperation as exc:
        raise ValueError("Укажите корректную ставку") from exc


def validate_interval(start, end, enforce_booking_notice=False):
    if start.tzinfo is None or end.tzinfo is None or start >= end:
        raise ValueError("Укажите корректные дату и время начала и возврата")
    moscow = ZoneInfo("Europe/Moscow")
    if enforce_booking_notice:
        earliest_date = now().astimezone(moscow).date() + timedelta(days=4)
        if start.astimezone(moscow).date() < earliest_date:
            raise ValueError("Выдачу можно назначить не раньше чем через 4 календарных дня; дата сегодня + 3 дня недоступна")
    if start < now() - timedelta(minutes=1):
        raise ValueError("Начало аренды уже прошло")


def expire_holds(session):
    expired = session.scalars(select(Booking).where(
        Booking.status == "pending", Booking.hold_expires_at <= now()).with_for_update()).all()
    for booking in expired:
        booking.status = "expired"
        booking.identity_status = "not_required"
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
        if identity:
            identity.delete_after = now() + timedelta(hours=24)
        session.add(Audit(booking_id=booking.id, actor_id=0, action="expired"))


def booking_total(start, end, rates):
    hours = Decimal(str((end - start).total_seconds())) / Decimal("3600")
    return (sum((Decimal(str(rate)) for rate in rates), Decimal("0")) * hours).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP)


def lines_total(start, end, lines):
    rates = []
    for line in lines:
        rates.extend([line.hourly_rate] * getattr(line, "billable_quantity", line.quantity))
    return booking_total(start, end, rates)


def _reserved_quantity(session, article_id, start, end, exclude_booking_id=None):
    article = session.get(Article, article_id)
    scheduled = and_(
        Booking.status.in_(ACTIVE_STATUSES),
        Booking.starts_at < end + timedelta(hours=article.buffer_hours),
        Booking.ends_at + timedelta(hours=article.buffer_hours) > start,
    )
    buffer_interval = text(f"interval '{int(article.buffer_hours)} hours'")
    actual_return = and_(
        Booking.status == "returned",
        Booking.returned_at.is_not(None),
        Booking.returned_at + buffer_interval > start,
    )
    query = select(Booking, BookingLine.quantity).join(
        BookingLine, Booking.id == BookingLine.booking_id).where(
        BookingLine.article_id == article_id,
        or_(scheduled, actual_return, and_(
            Booking.status.in_({"issued", "return_inspection"}), Booking.ends_at <= now())),
    )
    if exclude_booking_id:
        query = query.where(Booking.id != exclude_booking_id)
    # Count the peak simultaneous occupancy, not the sum of every booking
    # touching a long requested interval. End events precede start events.
    events = []
    buffer = timedelta(hours=article.buffer_hours)
    for booking, quantity in session.execute(query):
        if booking.status == "returned":
            occupied_start, occupied_end = booking.returned_at, booking.returned_at + buffer
            quantity = session.scalar(select(func.count()).select_from(BookingAsset).join(
                Equipment, Equipment.id == BookingAsset.equipment_id).where(
                BookingAsset.booking_id == booking.id, Equipment.article_id == article_id,
                Equipment.condition == "available")) or 0
        else:
            occupied_start, occupied_end = booking.starts_at, booking.ends_at + buffer
            if booking.status in {"issued", "return_inspection"} and booking.ends_at <= now():
                occupied_end = datetime.max.replace(tzinfo=timezone.utc)
        left, right = max(start, occupied_start), min(end + buffer, occupied_end)
        if left < right:
            events.extend(((left, quantity), (right, -quantity)))
    current = peak = 0
    for _, delta in sorted(events):
        current += delta
        peak = max(peak, current)
    return peak


def _capacity(session, article_id):
    return int(session.scalar(select(func.count()).select_from(Equipment).where(
        Equipment.article_id == article_id, Equipment.condition == "available")) or 0)


def availability(start, end):
    validate_interval(start, end)
    with Session.begin() as session:
        expire_holds(session)
        articles = session.scalars(select(Article).where(Article.is_active.is_(True)).order_by(Article.name)).all()
        result = []
        for article in articles:
            capacity = _capacity(session, article.id)
            reserved = _reserved_quantity(session, article.id, start, end)
            available_count = max(0, capacity - reserved)
            result.append({
                "id": article.id, "sku": article.sku, "name": article.name,
                "description": article.description, "image_url": article.image_url,
                "category": article.category,
                "buffer_hours": article.buffer_hours, "capacity": capacity,
                "available_quantity": available_count, "available": available_count > 0,
                "dependencies": [],
                "billable_dependencies": [],
            })
        return result


def _normalize_lines(session, requested):
    quantities = defaultdict(int)
    billable_quantities = defaultdict(int)
    auto_added = set()
    for entry in requested:
        if isinstance(entry, dict):
            article_id, quantity = int(entry["article_id"]), int(entry["quantity"])
        else:  # Compatibility with old equipment-id callers.
            equipment = session.get(Equipment, int(entry))
            if not equipment or not equipment.article_id:
                raise ValueError("Оборудование не найдено")
            article_id, quantity = equipment.article_id, 1
        if quantity < 1 or quantity > 30:
            raise ValueError("Количество каждой позиции должно быть от 1 до 30")
        quantities[article_id] += quantity
        billable_quantities[article_id] += quantity
        if quantities[article_id] > 30:
            raise ValueError("Количество каждой позиции должно быть от 1 до 30")
    if not quantities or len(quantities) > 30:
        raise ValueError("Выберите оборудование")
    articles = {article.id: article for article in session.scalars(
        select(Article).where(Article.id.in_(list(quantities)), Article.is_active.is_(True))).all()}
    if len(articles) != len(quantities):
        raise Conflict("Один из артикулов больше недоступен")
    return [(articles[article_id], quantity, Decimal("0"),
             article_id in auto_added, billable_quantities[article_id])
            for article_id, quantity in quantities.items()]


def create_booking(customer_id, customer_name, customer_contact, start, end, requested,
                   request_id=None, expected_total=None, return_created=False):
    try:
        with Session.begin() as session:
            if request_id:
                session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                                {"key": f"request:{customer_id}:{request_id}"})
                previous = session.scalar(select(Booking.id).where(
                    Booking.customer_id == customer_id, Booking.client_request_id == request_id))
                if previous:
                    return (previous, False) if return_created else previous
            validate_interval(start, end, enforce_booking_notice=True)
            if not customer_name.strip() or not customer_contact.strip():
                raise ValueError("Нужны имя и контакт клиента")
            normalized = _normalize_lines(session, requested)
            for article, _, _, _, _ in sorted(normalized, key=lambda row: row[0].id):
                session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": article.id})
            expire_holds(session)
            for article, quantity, _, _, _ in normalized:
                free = _capacity(session, article.id) - _reserved_quantity(session, article.id, start, end)
                if free < quantity:
                    raise Conflict(f"Недостаточно свободных единиц: {article.name}")
            booking = Booking(
                customer_id=customer_id, client_request_id=request_id,
                customer_name=customer_name.strip(), customer_contact=customer_contact.strip(),
                starts_at=start, ends_at=end, status="pending",
                hold_expires_at=now() + timedelta(minutes=30), identity_status="not_required",
            )
            session.add(booking)
            session.flush()
            for article, quantity, rate, auto_added, billable_quantity in normalized:
                session.add(BookingLine(booking_id=booking.id, article_id=article.id,
                                        quantity=quantity, billable_quantity=billable_quantity,
                                        hourly_rate=rate, auto_added=auto_added))
            session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="created"))
            session.flush()
            return (booking.id, True) if return_created else booking.id
    except IntegrityError as exc:
        if request_id:
            with Session() as session:
                previous = session.scalar(select(Booking.id).where(
                    Booking.customer_id == customer_id, Booking.client_request_id == request_id))
                if previous:
                    return (previous, False) if return_created else previous
        raise Conflict("На выбранное время нужного количества уже нет") from exc


def _booking_query():
    return select(Booking).options(
        selectinload(Booking.lines).selectinload(BookingLine.article),
        selectinload(Booking.lines).selectinload(BookingLine.assets).selectinload(BookingAsset.equipment).selectinload(Equipment.article),
        selectinload(Booking.assets).selectinload(BookingAsset.equipment).selectinload(Equipment.article),
        selectinload(Booking.items).selectinload(BookingItem.equipment),
        selectinload(Booking.inspections),
    )


def get_booking(booking_id):
    with Session() as session:
        return session.scalar(_booking_query().where(Booking.id == booking_id))


def delete_booking(booking_id, actor_id):
    """Permanently remove a booking and all booking-scoped data."""
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        if booking is None:
            raise ValueError("Заявка не найдена")

        repair_tickets = session.scalars(select(RepairTicket).where(
            RepairTicket.booking_id == booking_id).with_for_update()).all()
        affected_equipment = {ticket.equipment_id for ticket in repair_tickets}
        session.execute(delete(RepairTicket).where(RepairTicket.booking_id == booking_id))
        session.execute(delete(BookingDocument).where(BookingDocument.booking_id == booking_id))
        for equipment_id in affected_equipment:
            equipment = session.get(Equipment, equipment_id)
            other_open_ticket = session.scalar(select(RepairTicket.id).where(
                RepairTicket.equipment_id == equipment_id,
                RepairTicket.status != "closed").limit(1))
            if equipment and equipment.condition == "maintenance" and not other_open_ticket:
                equipment.condition = "available"

        identity_ids = select(CustomerIdentity.id).where(CustomerIdentity.booking_id == booking_id)
        session.execute(delete(IdentityDocument).where(IdentityDocument.identity_id.in_(identity_ids)))
        session.execute(delete(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        session.execute(delete(PrivacyConsent).where(PrivacyConsent.booking_id == booking_id))
        session.execute(delete(PIIAudit).where(PIIAudit.booking_id == booking_id))
        session.execute(delete(Audit).where(Audit.booking_id == booking_id))
        session.execute(delete(Inspection).where(Inspection.booking_id == booking_id))
        session.execute(delete(Occupancy).where(Occupancy.booking_id == booking_id))
        session.execute(delete(BookingItem).where(BookingItem.booking_id == booking_id))
        session.execute(delete(BookingAsset).where(BookingAsset.booking_id == booking_id))
        session.execute(delete(BookingLine).where(BookingLine.booking_id == booking_id))
        session.execute(delete(Booking).where(Booking.id == booking_id))
        session.add(BookingDeletionAudit(deleted_booking_id=booking_id, actor_id=actor_id))


def get_booking_by_request(customer_id, request_id):
    with Session() as session:
        return session.scalar(select(Booking.id).where(
            Booking.customer_id == customer_id, Booking.client_request_id == request_id))


def update_booking_contact(booking_id, customer_id, customer_name, customer_contact):
    """Allow the customer to correct name/contact only before manager approval."""
    with Session.begin() as session:
        expire_holds(session)
        booking = session.scalar(select(Booking).where(
            Booking.id == booking_id, Booking.customer_id == customer_id).with_for_update())
        if booking is None:
            raise ValueError("Заявка не найдена")
        if booking.status != "pending":
            raise Conflict("Имя и контакт можно изменить только до подтверждения менеджером")
        if not customer_name.strip() or not customer_contact.strip():
            raise ValueError("Укажите имя и телефон или Telegram username")
        booking.customer_name = customer_name.strip()
        booking.customer_contact = customer_contact.strip()
        session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="contact_updated"))
        return booking.id


def list_bookings(limit=200):
    with Session.begin() as session:
        expire_holds(session)
        return session.scalars(_booking_query().order_by(Booking.created_at.desc()).limit(limit)).all()


def list_customer_bookings(customer_id):
    with Session.begin() as session:
        expire_holds(session)
        return session.scalars(_booking_query().where(Booking.customer_id == customer_id)
                               .order_by(Booking.created_at.desc()).limit(50)).all()


def _asset_conflicts(session, booking, equipment_id):
    article = session.get(Equipment, equipment_id).article
    scheduled = and_(
        Booking.status.in_(ACTIVE_STATUSES),
        Booking.starts_at < booking.ends_at + timedelta(hours=article.buffer_hours),
        Booking.ends_at + timedelta(hours=article.buffer_hours) > booking.starts_at,
    )
    buffer_interval = text(f"interval '{int(article.buffer_hours)} hours'")
    actual_return = and_(
        Booking.status == "returned",
        Booking.returned_at.is_not(None),
        Booking.returned_at + buffer_interval > booking.starts_at,
    )
    return session.scalar(select(func.count()).select_from(BookingAsset).join(
        Booking, Booking.id == BookingAsset.booking_id).where(
        BookingAsset.equipment_id == equipment_id,
        Booking.id != booking.id,
        or_(scheduled, actual_return, and_(
            Booking.status.in_({"issued", "return_inspection"}), Booking.ends_at <= now())),
    )) > 0


def _validate_asset(asset, article_id):
    if not asset or asset.article_id != article_id or asset.condition != "available":
        raise Conflict("Экземпляр не соответствует артикулу или недоступен")
    if asset.article and asset.article.category == "battery":
        if asset.health_percent is None or asset.health_percent < 80:
            raise Conflict(f"Аккумулятор {asset.inventory_number}: здоровье ниже 80%")
        if asset.charge_percent is None or asset.charge_percent < 95:
            raise Conflict(f"Аккумулятор {asset.inventory_number}: заряд ниже 95%")


def assign_booking_assets(booking_id, actor_id, assignments=None):
    with Session.begin() as session:
        booking = session.scalar(select(Booking).options(selectinload(Booking.lines)).where(
            Booking.id == booking_id).with_for_update())
        if not booking or booking.status not in {"confirmed", "preparing"}:
            raise Conflict("Комплектация доступна только для подтверждённого заказа")
        if booking.identity_status != "verified":
            raise Conflict("Сначала клиент должен заполнить документы и пройти проверку у оператора")
        old_assets = set(session.scalars(select(BookingAsset.equipment_id).where(
            BookingAsset.booking_id == booking.id)).all())
        session.execute(delete(BookingAsset).where(BookingAsset.booking_id == booking.id))
        new_assets = set()
        for line in booking.lines:
            selected = assignments.get(str(line.id), assignments.get(line.id, [])) if assignments else []
            if not selected:
                candidates = session.scalars(select(Equipment).where(
                    Equipment.article_id == line.article_id, Equipment.condition == "available")
                    .order_by(Equipment.storage_location, Equipment.inventory_number)).all()
                selected = []
                for asset in candidates:
                    try:
                        _validate_asset(asset, line.article_id)
                    except Conflict:
                        continue
                    if not _asset_conflicts(session, booking, asset.id):
                        selected.append(asset.id)
                    if len(selected) == line.quantity:
                        break
            if len(set(selected)) != line.quantity:
                raise Conflict(f"Для строки {line.id} нужно выбрать {line.quantity} экз.")
            for equipment_id in selected:
                session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": int(equipment_id)})
                asset = session.get(Equipment, int(equipment_id))
                _validate_asset(asset, line.article_id)
                if _asset_conflicts(session, booking, asset.id):
                    raise Conflict(f"Экземпляр {asset.inventory_number} уже назначен")
                session.add(BookingAsset(booking_id=booking.id, booking_line_id=line.id,
                                         equipment_id=asset.id))
                new_assets.add(asset.id)
        # Results for removed assets must never satisfy checks for replacements.
        if old_assets != new_assets:
            session.execute(delete(Inspection).where(
                Inspection.booking_id == booking.id,
                Inspection.equipment_id.in_(old_assets ^ new_assets)))
            booking.act_signed_at = booking.act_signed_by = None
        booking.status = "preparing"
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action="preparing"))
        return booking.status


def record_inspection(booking_id, equipment_id, stage, result, checklist, notes, actor_id,
                      defect="", estimated_cost=0, charge_customer=False):
    if stage not in {"pre_issue", "check_in"} or result not in {"pass", "fail"}:
        raise ValueError("Неверный результат проверки")
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        expected_status = "preparing" if stage == "pre_issue" else "return_inspection"
        if not booking or booking.status != expected_status:
            raise ValueError("Проверка недоступна на текущем этапе заказа")
        assigned = session.get(BookingAsset, (booking_id, equipment_id))
        if not assigned:
            raise ValueError("Экземпляр не назначен заказу")
        asset = session.get(Equipment, equipment_id)
        record = session.scalar(select(Inspection).where(
            Inspection.booking_id == booking_id, Inspection.equipment_id == equipment_id,
            Inspection.stage == stage))
        if record is None:
            record = Inspection(booking_id=booking_id, equipment_id=equipment_id, stage=stage,
                                actor_id=actor_id)
        record.result, record.checklist, record.notes, record.defect = result, checklist or {}, notes.strip(), (defect or "").strip()[:4000]
        record.estimated_cost, record.charge_customer, record.actor_id = Decimal(str(estimated_cost)), bool(charge_customer), actor_id
        session.add(record)
        if result == "fail":
            asset.condition = "maintenance"
            ticket = session.scalar(select(RepairTicket).where(
                RepairTicket.booking_id == booking_id, RepairTicket.equipment_id == equipment_id,
                RepairTicket.status != "closed"))
            if ticket is None:
                session.add(RepairTicket(booking_id=booking_id, equipment_id=equipment_id,
                                         defect=(defect or notes or "Требуется диагностика")[:4000],
                                         estimated_cost=Decimal(str(estimated_cost)),
                                         charge_customer=bool(charge_customer)))
            else:
                ticket.defect = (defect or notes or ticket.defect or "Требуется диагностика")[:4000]
                ticket.estimated_cost = Decimal(str(estimated_cost))
                ticket.charge_customer = bool(charge_customer)


def mark_act_signed(booking_id, actor_id):
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        if not booking or booking.status != "ready" or booking.identity_status != "verified":
            raise Conflict("Нужны готовый заказ и проверенные документы клиента")
        booking.act_signed_at, booking.act_signed_by = now(), actor_id
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action="act_signed"))


TRANSITIONS = {
    "pending": {"confirmed", "cancelled"},
    "confirmed": {"preparing", "cancelled"},
    "preparing": {"ready", "cancelled"},
    "ready": {"issued", "cancelled"},
    "issued": {"return_inspection"},
    "return_inspection": {"returned"},
}


def transition(booking_id, action, actor_id, customer_id=None):
    if customer_id is not None and action != "cancelled":
        raise Conflict("Клиент может только отменить свою заявку")
    if action == "preparing":
        return assign_booking_assets(booking_id, actor_id)
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        if booking is None or (customer_id is not None and booking.customer_id != customer_id):
            raise ValueError("Заявка не найдена")
        if customer_id is not None and booking.status not in {"pending", "confirmed"}:
            raise Conflict("Отмена клиентом доступна только до начала комплектации")
        if booking.status == "pending" and booking.hold_expires_at <= now():
            booking.status = "expired"
            session.add(Audit(booking_id=booking.id, actor_id=0, action="expired"))
            return "expired"
        if action not in TRANSITIONS.get(booking.status, set()):
            raise Conflict("Недопустимое изменение статуса")
        if action == "confirmed":
            booking.identity_status = "required"
        elif action == "ready":
            assigned = session.scalar(select(func.count()).select_from(BookingAsset).where(
                BookingAsset.booking_id == booking.id))
            required = session.scalar(select(func.coalesce(func.sum(BookingLine.quantity), 0)).where(
                BookingLine.booking_id == booking.id))
            passed = session.scalar(select(func.count()).select_from(Inspection).join(
                BookingAsset, and_(BookingAsset.booking_id == Inspection.booking_id,
                                   BookingAsset.equipment_id == Inspection.equipment_id)).where(
                Inspection.booking_id == booking.id, Inspection.stage == "pre_issue",
                Inspection.result == "pass"))
            unavailable = session.scalar(select(func.count()).select_from(BookingAsset).join(
                Equipment, Equipment.id == BookingAsset.equipment_id).where(
                BookingAsset.booking_id == booking.id, Equipment.condition != "available"))
            if not required or assigned != required or passed != assigned or unavailable:
                raise Conflict("Комплектация или предвыдачная проверка не завершена")
        elif action == "issued":
            if booking.identity_status != "verified" or not booking.act_signed_at:
                raise Conflict("Проверьте документы клиента и отметьте подписание акта")
        elif action == "returned":
            assigned = session.scalar(select(func.count()).select_from(BookingAsset).where(
                BookingAsset.booking_id == booking.id))
            checked = session.scalar(select(func.count()).select_from(Inspection).where(
                Inspection.booking_id == booking.id, Inspection.stage == "check_in"))
            if checked != assigned:
                raise Conflict("Проверьте каждый возвращённый экземпляр")
            booking.returned_at = now()
            identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
            if identity:
                identity.delete_after = now() + timedelta(days=90)
        elif action == "cancelled":
            booking.identity_status = "not_required"
            identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
            if identity:
                identity.delete_after = now() + timedelta(hours=24)
        booking.status = action
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action=action))
        return booking.status


def list_equipment():
    with Session() as session:
        return session.scalars(select(Equipment).options(selectinload(Equipment.article))
                               .order_by(Equipment.name, Equipment.inventory_number)).all()


def list_articles():
    with Session() as session:
        return session.scalars(select(Article).options(selectinload(Article.equipment)).order_by(Article.name)).all()


def list_dependencies():
    with Session() as session:
        return session.scalars(select(ArticleDependency).order_by(
            ArticleDependency.parent_article_id, ArticleDependency.child_article_id)).all()


def save_dependency(parent_article_id, child_article_id, quantity=1, billable=False):
    if parent_article_id == child_article_id or not 1 <= int(quantity) <= 30:
        raise ValueError("Неверная зависимость комплекта")
    with Session.begin() as session:
        if not session.get(Article, parent_article_id) or not session.get(Article, child_article_id):
            raise ValueError("Артикул не найден")
        graph = defaultdict(set)
        for item in session.scalars(select(ArticleDependency)).all():
            graph[item.parent_article_id].add(item.child_article_id)
        frontier, visited = [child_article_id], set()
        while frontier:
            node = frontier.pop()
            if node == parent_article_id:
                raise ValueError("Зависимости комплектов не могут образовывать цикл")
            if node not in visited:
                visited.add(node)
                frontier.extend(graph[node])
        dependency = session.get(ArticleDependency, (parent_article_id, child_article_id))
        if dependency is None:
            dependency = ArticleDependency(parent_article_id=parent_article_id,
                                           child_article_id=child_article_id)
        dependency.quantity, dependency.billable = int(quantity), bool(billable)
        session.add(dependency)


def delete_dependency(parent_article_id, child_article_id):
    with Session.begin() as session:
        dependency = session.get(ArticleDependency, (parent_article_id, child_article_id))
        if dependency:
            session.delete(dependency)


def save_article(sku, name, description, rate, category="generic", profile="generic",
                 buffer_hours=24, image_url="", article_id=None, active=True, composition=""):
    rate = validated_rate(rate)
    if not sku.strip() or not name.strip():
        raise ValueError("Укажите артикул и название модели")
    if (Decimal(str(rate)) < 0 or not 0 <= int(buffer_hours) <= 168 or
            category not in {"generic", "camera", "optics", "light", "battery", "accessory"} or
            profile not in {"generic", "camera", "optics", "light", "battery"}):
        raise ValueError("Неверная ставка или буфер")
    if image_url and (urlparse(image_url).scheme != "https" or not urlparse(image_url).netloc):
        raise ValueError("Ссылка на фото должна начинаться с HTTPS")
    with Session.begin() as session:
        article = session.get(Article, article_id) if article_id else Article()
        if article is None:
            raise ValueError("Артикул не найден")
        article.sku, article.name = sku.strip(), name.strip()
        article.description, article.hourly_rate = description.strip(), Decimal(str(rate))
        article.composition = (composition or "").strip()[:4000]
        article.category, article.inspection_profile = category, profile
        article.buffer_hours, article.image_url, article.is_active = int(buffer_hours), image_url.strip(), bool(active)
        session.add(article)
        session.flush()
        return article.id


def save_equipment(number, name, description, rate, condition, equipment_id=None, image_url=None,
                   article_id=None, storage_location="", health_percent=None, charge_percent=None):
    rate = validated_rate(rate)
    if not number.strip():
        raise ValueError("Укажите серийный номер")
    if condition not in {"available", "maintenance", "retired"} or Decimal(str(rate)) < 0:
        raise ValueError("Неверное состояние или ставка")
    if image_url and (len(image_url) > 500 or urlparse(image_url).scheme != "https" or not urlparse(image_url).netloc):
        raise ValueError("Ссылка на фото должна начинаться с HTTPS")
    with Session.begin() as session:
        if article_id:
            article = session.get(Article, article_id)
        else:
            article = session.scalar(select(Article).where(
                Article.name == name.strip(), Article.hourly_rate == Decimal(str(rate)),
                Article.description == description.strip(), Article.image_url == (image_url or "")))
            if article is None:
                article = Article(sku=f"AUTO-{uuid4().hex[:10].upper()}", name=name.strip(),
                                  description=description.strip(), hourly_rate=Decimal(str(rate)),
                                  image_url=image_url or "")
                session.add(article)
                session.flush()
        if article is None:
            raise ValueError("Артикул не найден")
        item = session.get(Equipment, equipment_id) if equipment_id else Equipment()
        if item is None:
            raise ValueError("Экземпляр не найден")
        if equipment_id and (condition != "available" or item.article_id != article.id):
            active = session.scalar(select(func.count()).select_from(BookingAsset).join(
                Booking, Booking.id == BookingAsset.booking_id).where(
                BookingAsset.equipment_id == equipment_id,
                Booking.status.in_(ACTIVE_STATUSES - {"returned"})))
            if active:
                raise Conflict("Сначала завершите или отмените действующий заказ")
        item.inventory_number, item.name = number.strip(), article.name
        item.description, item.hourly_rate = article.description, article.hourly_rate
        item.image_url, item.article_id, item.condition = article.image_url, article.id, condition
        item.storage_location = storage_location.strip()
        item.health_percent, item.charge_percent = health_percent, charge_percent
        session.add(item)
        session.flush()
        return item.id


def list_repairs():
    with Session() as session:
        return session.scalars(select(RepairTicket).options(selectinload(RepairTicket.equipment))
                               .order_by(RepairTicket.created_at.desc())).all()


def close_repair(ticket_id, actor_id):
    with Session.begin() as session:
        ticket = session.scalar(select(RepairTicket).where(
            RepairTicket.id == ticket_id).with_for_update())
        if not ticket:
            raise ValueError("Тикет ремонта не найден")
        if ticket.status == "closed":
            return
        ticket.status, ticket.closed_at = "closed", now()
        equipment = session.get(Equipment, ticket.equipment_id)
        other_open = session.scalar(select(RepairTicket.id).where(
            RepairTicket.equipment_id == ticket.equipment_id,
            RepairTicket.id != ticket.id, RepairTicket.status != "closed").limit(1))
        if equipment and equipment.condition == "maintenance" and not other_open:
            equipment.condition = "available"
        if ticket.booking_id:
            identity = session.scalar(select(CustomerIdentity).where(
                CustomerIdentity.booking_id == ticket.booking_id))
            booking = session.get(Booking, ticket.booking_id)
            if identity and booking and booking.status == "returned":
                identity.delete_after = now() + timedelta(days=90)
            session.add(Audit(booking_id=ticket.booking_id, actor_id=actor_id,
                              action="repair_closed"))
