"""Transactional paper-receipt workflow. UI attestations are not electronic signatures."""
from datetime import datetime, timezone
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, delete

from .db import (Audit, Booking, BookingAsset, BookingDocument, BookingHandover, CustomerIdentity,
                 Equipment, Inspection, PIIAudit, ReceiptArchive, Session, StaffRole, TrustedSigner)
from .inventory import inventory_details, require_role
from .pii import _decrypt_payload, _master_key
from .receipt_archive import _five_years_after
from .rental import Conflict, _claim_stage
from .roles import configured_ids


def now():
    return datetime.now(timezone.utc)


def handover_state(booking_id, session=None):
    if session is None:
        with Session() as current:
            return handover_state(booking_id, current)
    row = session.get(BookingHandover, booking_id)
    return dict(row.data) if row else {}


def _row(session, booking_id):
    row = session.get(BookingHandover, booking_id)
    if row is None:
        row = BookingHandover(booking_id=booking_id, data={})
        session.add(row)
    return row


def asset_components(session,booking_id,equipment_id):
    row=session.get(BookingHandover,booking_id)
    if row and row.data.get("snapshot"):
        saved=next((item for item in row.data["snapshot"] if item["id"]==equipment_id),None)
        return saved.get("components",[]) if saved else []
    from .inventory import composition_items
    asset=session.get(Equipment,equipment_id)
    exceptions=row.data.get("exceptions",[]) if row else []
    result=[]
    for component in composition_items(asset.article):
        exception=next((item for item in exceptions if item.get("equipment_id")==equipment_id and item.get("component")==component),None)
        result.append({"name":component,"state":exception["reason"] if exception else "issued",
                       "replacement_name":exception.get("replacement_name","") if exception else ""})
    return result


def composition_signature(components):
    return hashlib.sha256(json.dumps(components,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def set_trusted_signer(actor_id, telegram_id, full_name, active):
    require_role(actor_id, "admin")
    if telegram_id not in configured_ids("ADMIN_IDS") or not full_name.strip() or len(full_name) > 200:
        raise ValueError("Укажите действующего сотрудника и его ФИО")
    with Session.begin() as session:
        role = session.get(StaffRole, telegram_id)
        if role is None:
            raise ValueError("Сначала назначьте роль сотруднику")
        row = session.get(TrustedSigner, telegram_id)
        if row is None:
            row = TrustedSigner(telegram_id=telegram_id)
            session.add(row)
        row.full_name, row.active = full_name.strip(), active
        session.add(PIIAudit(booking_id=None, actor_id=actor_id, action="trusted_signer_updated"))


def reset_draft(session, booking_id):
    """Only a pre-issue draft can be rebuilt. Issued snapshots are immutable."""
    row = session.get(BookingHandover, booking_id)
    if row and (row.data.get("issued_at") or row.data.get("legacy_issue")):
        raise Conflict("Выданная расписка неизменяема")
    if session.get(ReceiptArchive,booking_id):
        raise Conflict("Архивированную расписку нельзя заменить")
    if row:
        row.data = {key: value for key, value in row.data.items() if key == "exceptions"}
        row.encrypted_recipient = row.recipient_nonce = None
    session.execute(delete(BookingDocument).where(BookingDocument.booking_id == booking_id,
                                                BookingDocument.kind == "receipt_pdf"))
    session.execute(delete(ReceiptArchive).where(ReceiptArchive.booking_id == booking_id))


def prepare_receipt(session, booking, actor_id, legacy=False):
    """Called with the booking lock in the ready transaction; no nested sessions."""
    from .receipt_pdf import render_receipt_pdf
    identity_row = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
    if identity_row is None or identity_row.status != "verified":
        raise Conflict("Для расписки необходима проверенная анкета клиента")
    identity, _ = _decrypt_payload(identity_row)
    row = _row(session, booking.id)
    if row.data.get("issued_at") or row.data.get("legacy_issue"):
        raise Conflict("Выданная расписка неизменяема")
    assets = session.scalars(select(BookingAsset).where(BookingAsset.booking_id == booking.id,
                                                     BookingAsset.deleted_at.is_(None)).order_by(BookingAsset.equipment_id)).all()
    snapshot = []
    for assigned in assets:
        item = session.get(Equipment, assigned.equipment_id, with_for_update=True)
        details = inventory_details(item.id, session)
        components=[] if legacy else asset_components(session,booking.id,item.id)
        inspection=session.scalar(select(Inspection).where(Inspection.booking_id==booking.id,Inspection.equipment_id==item.id,Inspection.stage=="pre_issue"))
        if not legacy and components and (inspection is None or inspection.checklist.get("__composition_signature")!=composition_signature(components) or any(not (inspection.checklist or {}).get(f"component:{index}") for index,component in enumerate(components) if component["state"] not in {"missing","faulty"})):
            raise Conflict("Комплектация изменилась. Повторите предвыдачную проверку")
        snapshot.append({"id": item.id, "name": item.article.name if item.article else item.name,
                         "code": item.inventory_number, "features": [] if legacy else details["features"], "components":components})
    data = {"exceptions": row.data.get("exceptions", []), "snapshot": snapshot,
            "recipient_id": booking.customer_id}
    if legacy:
        data.update({"legacy_issue": True, "legacy_snapshot_unknown": True})
    row.recipient_nonce = os.urandom(12)
    row.encrypted_recipient = AESGCM(_master_key()).encrypt(row.recipient_nonce,
        identity["full_name"].encode(), f"recipient:{booking.id}".encode())
    body = render_receipt_pdf(booking.id, actor_id, booking=booking, identity=identity,
                              snapshot=snapshot, exceptions=data["exceptions"], legacy=legacy)
    timestamp, nonce = now(), os.urandom(12)
    document = session.get(BookingDocument, (booking.id, "receipt_pdf"))
    if document is None:
        document = BookingDocument(booking_id=booking.id, kind="receipt_pdf")
        session.add(document)
    document.filename = f"receipt-{(booking.human_number or str(booking.id)).replace('ТС', 'TS')}.pdf"
    document.media_type = "application/pdf"
    document.nonce, document.sha256 = nonce, hashlib.sha256(body).hexdigest()
    document.encrypted_data = AESGCM(_master_key()).encrypt(nonce, body, f"{booking.id}:receipt_pdf:doc-v1".encode())
    if legacy:
        lifecycle = session.get(ReceiptArchive, booking.id)
        if lifecycle is not None:
            raise Conflict("Расписка уже находится в архиве")
        session.add(ReceiptArchive(booking_id=booking.id,created_at=timestamp,expires_at=_five_years_after(timestamp)))
    row.data = data
    session.add(PIIAudit(booking_id=booking.id, actor_id=actor_id, action="document_archived" if legacy else "document_preview_saved"))


def migrate_legacy_receipt(booking_id, actor_id):
    require_role(actor_id)
    if actor_id not in configured_ids("PII_ADMIN_IDS"):
        raise PermissionError("Перенос старой выдачи требует доступа к проверенной анкете")
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.deleted_at or booking.status not in {"issued", "return_inspection"}:
            raise Conflict("Перенос доступен для старой активной выдачи")
        row = session.get(BookingHandover, booking_id)
        if row and row.data.get("snapshot"):
            raise Conflict("Расписка уже подготовлена")
        prepare_receipt(session, booking, actor_id, legacy=True)
        session.add(Audit(booking_id=booking_id, actor_id=actor_id, action="legacy_receipt_migrated"))


def customer_attest(booking_id, customer_id, action, acknowledged=False):
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.customer_id != customer_id or booking.deleted_at:
            raise ValueError("Заявка не найдена")
        row = session.get(BookingHandover, booking_id)
        if row is None:
            raise Conflict("Сначала сотрудник должен подготовить расписку")
        data = dict(row.data)
        if data.get("recipient_id") != customer_id:
            raise Conflict("Вернуть оборудование может только получатель")
        if action == "received":
            if booking.status != "ready" or not data.get("snapshot"):
                raise Conflict("Получение доступно для готовой заявки")
            if data.get("exceptions") and not acknowledged:
                raise Conflict("Подтвердите ознакомление с перечнем частичной выдачи")
            data.setdefault("received_at", now().isoformat())
            data["exceptions_acknowledged"] = acknowledged
        elif action == "returning":
            from .schedule import validate_operation_window
            validate_operation_window()
            if booking.status != "issued" and not (booking.status == "return_inspection" and data.get("legacy_issue")):
                raise Conflict("Возврат доступен только после выдачи")
            data["returning_at"] = now().isoformat()
            if booking.status == "issued":
                booking.status, booking.inspection_cycle_started_at = "return_inspection", now()
                from .db import BookingOperationLease
                session.execute(delete(BookingOperationLease).where(BookingOperationLease.booking_id == booking.id))
                session.add(Audit(booking_id=booking.id, actor_id=customer_id, action="return_inspection"))
                from .booking_changes import queue
                queue(session, booking, "customer_returning_operator", "Оборудование на приёмке. Откройте заявку в Mini App.", booking.assignee_id or next(iter(configured_ids("ADMIN_IDS"))))
        else:
            raise ValueError("Неизвестное подтверждение")
        row.data = data
        session.add(Audit(booking_id=booking.id, actor_id=customer_id, action=f"customer_{action}"))


def attest_paper_signature(booking_id, actor_id, point, identity_matches, paper_signed):
    require_role(actor_id)
    from .schedule import validate_operation_window
    validate_operation_window()
    if point not in {"issue", "return"} or not identity_matches or not paper_signed:
        raise Conflict("Сверьте личность получателя и подтвердите бумажную подпись")
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        expected = "ready" if point == "issue" else "return_inspection"
        if not booking or booking.deleted_at or booking.status != expected:
            raise Conflict("Подписание недоступно на этом этапе")
        signer = session.get(TrustedSigner, actor_id, with_for_update=True)
        if signer is None or not signer.active:
            raise PermissionError("Подписывать может только действующий доверенный сотрудник")
        _claim_stage(session, booking, actor_id, stage=f"paper_{point}")
        row = session.get(BookingHandover, booking_id)
        if row is None:
            raise Conflict("Расписка ещё не подготовлена")
        data = dict(row.data)
        if data.get("recipient_id") != booking.customer_id:
            raise Conflict("Получатель заявки изменился")
        key = f"{point}_signature"
        if key in data:
            raise Conflict("Подписание уже отмечено")
        data[key] = {"actor_id": actor_id, "full_name": signer.full_name, "at": now().isoformat(), "identity_matches": True}
        row.data = data
        from .db import BookingOperationLease
        lease = session.get(BookingOperationLease, (booking.id, f"paper_{point}"))
        if lease:
            session.delete(lease)
        session.add(Audit(booking_id=booking.id, actor_id=actor_id, action=f"paper_{point}_signed"))


def validate_issue(session, booking, actor_id=None):
    row = session.get(BookingHandover, booking.id)
    data = row.data if row else {}
    if (booking.identity_status != "verified" or not data.get("received_at") or
            not data.get("issue_signature") or data.get("recipient_id") != booking.customer_id or
            (data.get("exceptions") and not data.get("exceptions_acknowledged"))):
        raise Conflict("Нужны расписка, «Получил», сверка личности и подпись доверенного сотрудника")
    document = session.get(BookingDocument, (booking.id, "receipt_pdf"))
    if document is None:
        raise Conflict("Сохранённая расписка отсутствует")
    from .inventory import composition_items
    from .receipt_archive import _decrypt
    from cryptography.exceptions import InvalidTag
    try:
        if hashlib.sha256(_decrypt(document)).hexdigest()!=document.sha256:
            raise Conflict("Сохранённая расписка повреждена; повторите подготовку")
    except InvalidTag as exc:
        raise Conflict("Сохранённая расписка повреждена; повторите подготовку") from exc
    for item in data.get("snapshot",[]):
        asset=session.get(Equipment,item["id"],with_for_update=True)
        if inventory_details(item["id"],session)["features"]!=item.get("features",[]) or composition_items(asset.article)!=[row["name"] for row in item.get("components",[])]:
            raise Conflict("Особенности или комплектация изменились. Верните заявку в подготовку и повторите подтверждения")
    if session.get(ReceiptArchive,booking.id) is not None:
        raise Conflict("Расписка уже архивирована")
    timestamp=now()
    session.add(ReceiptArchive(booking_id=booking.id,created_at=timestamp,expires_at=_five_years_after(timestamp)))
    session.add(PIIAudit(booking_id=booking.id,actor_id=actor_id or 0,action="document_archived"))
    data = dict(data)
    data["issued_at"] = now().isoformat()
    data["issued_by"] = actor_id
    row.data = data


def validate_return_start(session, booking):
    row = session.get(BookingHandover, booking.id)
    if row is None:
        raise Conflict("Для старой заявки сначала подготовьте расписку через перенос выдачи")
    if not row.data.get("returning_at") or row.data.get("recipient_id") != booking.customer_id:
        raise Conflict("Получатель должен отметить «Сдаю оборудование»")


def validate_return_finish(session, booking, actor_id=None):
    row = session.get(BookingHandover, booking.id)
    if row is None or not row.data.get("return_signature") or not row.data.get("returning_at"):
        raise Conflict("Отметьте приём, совпадение личности и бумажную подпись")
    row.data = {**row.data, "returned_at": now().isoformat(), "returned_by": actor_id}


def record_return_finding(booking_id, equipment_id, actor_id, kind, description):
    require_role(actor_id)
    if kind not in {"existing", "damage", "lost"} or not description.strip() or len(description) > 2000:
        raise ValueError("Укажите тип и описание результата")
    from .inventory import EquipmentFeature, InventoryAudit
    from .db import EquipmentOwner
    from .booking_changes import queue
    with Session.begin() as session:
        booking = session.get(Booking, booking_id, with_for_update=True)
        if not booking or booking.status != "return_inspection":
            raise Conflict("Результат доступен при проверке возврата")
        _claim_stage(session, booking, actor_id)
        assigned = session.get(BookingAsset, (booking_id, equipment_id))
        if not assigned or assigned.deleted_at:
            raise ValueError("Экземпляр не был выдан")
        row = _row(session, booking_id)
        finding = {"equipment_id": equipment_id, "kind": kind, "description": description.strip(), "actor_id": actor_id, "at": now().isoformat()}
        row.data = {**row.data, "findings": [*row.data.get("findings", []), finding]}
        if kind == "existing":
            session.get(Equipment, equipment_id, with_for_update=True)
            session.add(EquipmentFeature(equipment_id=equipment_id, description=description.strip(),
                        source="found_on_return", actor_id=actor_id))
            session.add(InventoryAudit(equipment_id=equipment_id, actor_id=actor_id,
                        action="feature_found_on_return", detail={"booking_id": booking_id, "description": description.strip()}))
        else:
            from .db import Inspection, RepairTicket
            asset = session.get(Equipment, equipment_id, with_for_update=True)
            asset.condition = "retired" if kind == "lost" else "maintenance"
            inspection = session.scalar(select(Inspection).where(Inspection.booking_id == booking_id,
                Inspection.equipment_id == equipment_id, Inspection.stage == "check_in"))
            if inspection is None:
                inspection = Inspection(booking_id=booking_id, equipment_id=equipment_id, stage="check_in", actor_id=actor_id)
                session.add(inspection)
            inspection.result, inspection.defect, inspection.notes = "fail", description.strip(), description.strip()
            inspection.checklist, inspection.created_at = {}, now()
            inspection.estimated_cost, inspection.charge_customer = 0, True
            ticket = session.scalar(select(RepairTicket).where(RepairTicket.booking_id == booking_id,
                RepairTicket.equipment_id == equipment_id, RepairTicket.status != "closed"))
            if ticket is None:
                session.add(RepairTicket(booking_id=booking_id, equipment_id=equipment_id, defect=description.strip(),
                            estimated_cost=0, charge_customer=True))
            owner = session.get(EquipmentOwner, equipment_id)
            if owner and owner.contact:
                from html import escape
                queue(session, booking, "owner_contact_required", f"По заявке {escape(booking.human_number or str(booking.id))} зафиксирован ущерб. Связаться с владельцем по контакту {escape(owner.contact)}.", actor_id)
        session.add(Audit(booking_id=booking_id, actor_id=actor_id, action=f"return_finding_{kind}"))
