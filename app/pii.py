"""Encrypted identity profiles and document images.

No plaintext identity value is logged or persisted outside the encrypted payload.
"""

import base64
import hashlib
import io
import json
import os
import re
from datetime import date, timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import and_, delete, exists, or_, select

from .db import (Booking, CustomerIdentity, IdentityDocument, PIIAudit, PrivacyConsent,
                 RepairTicket, Session)
from .rental import Conflict, now
from .universities import UNIVERSITY_SET


DOCUMENT_KINDS = {"passport_main", "passport_registration", "student_front"}
MAX_FILE_SIZE = 8 * 1024 * 1024
MAX_TOTAL_SIZE = 32 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 30_000_000


class IdentityFieldError(ValueError):
    def __init__(self, field, message):
        super().__init__(message)
        self.field = field


def validate_identity_payload(payload, legacy_institution=None):
    """Validate user-entered identity fields without logging their values."""
    required = {
        "full_name", "birth_date", "passport_series", "passport_number",
        "passport_issued_at", "passport_issuer", "passport_division_code",
        "registration_address", "residential_address", "student_id_number",
        "student_institution",
    }
    if not isinstance(payload, dict):
        raise IdentityFieldError("full_name", "Проверьте данные анкеты")
    missing = required - set(payload)
    if missing:
        field = sorted(missing)[0]
        raise IdentityFieldError(field, "Заполните это поле")
    if set(payload) != required:
        raise IdentityFieldError("full_name", "Форма устарела. Перезапустите приложение и повторите отправку")
    for field, value in payload.items():
        if not isinstance(value, str) or not value.strip():
            raise IdentityFieldError(field, "Заполните это поле")
        if len(value.strip()) > 500:
            raise IdentityFieldError(field, "Слишком длинное значение")
    if not re.fullmatch(r"[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z .'-]{1,199}", payload["full_name"].strip()) or len(payload["full_name"].split()) < 2:
        raise IdentityFieldError("full_name", "Укажите ФИО буквами, минимум два слова")
    if not re.fullmatch(r"\d{4}", payload["passport_series"]):
        raise IdentityFieldError("passport_combined", "Введите 4 цифры серии паспорта и 6 цифр номера")
    if not re.fullmatch(r"\d{6}", payload["passport_number"]):
        raise IdentityFieldError("passport_combined", "Введите 4 цифры серии паспорта и 6 цифр номера")
    if not re.fullmatch(r"\d{3}-\d{3}", payload["passport_division_code"]):
        raise IdentityFieldError("passport_division_code", "Введите код в формате 000-000")
    try:
        birth_date = date.fromisoformat(payload["birth_date"])
    except ValueError as exc:
        raise IdentityFieldError("birth_date", "Проверьте дату рождения") from exc
    try:
        passport_issued_at = date.fromisoformat(payload["passport_issued_at"])
    except ValueError as exc:
        raise IdentityFieldError("passport_issued_at", "Проверьте дату выдачи паспорта") from exc
    today = date.today()
    if birth_date < date(1900, 1, 1) or birth_date > today:
        raise IdentityFieldError("birth_date", "Дата рождения указана некорректно")
    if passport_issued_at < birth_date or passport_issued_at > today:
        raise IdentityFieldError("passport_issued_at", "Дата выдачи паспорта указана некорректно")
    if not re.fullmatch(r"\d{8}", payload["student_id_number"]):
        raise IdentityFieldError("student_id_number", "Номер студенческого должен содержать ровно 8 цифр")
    institution = payload["student_institution"].strip()
    if institution not in UNIVERSITY_SET and institution != legacy_institution:
        raise IdentityFieldError("student_institution", "Выберите вуз из списка Санкт-Петербурга")
    for field in ("passport_issuer", "registration_address", "residential_address", "student_id_number", "student_institution"):
        if any(ord(char) < 32 for char in payload[field]):
            raise IdentityFieldError(field, "Уберите недопустимые управляющие символы")
    return {key: value.strip() for key, value in payload.items()}


def pii_admin_ids():
    return {int(value.strip()) for value in os.getenv("PII_ADMIN_IDS", "").split(",")
            if value.strip().isdigit()}


def operator_ready():
    return all(os.getenv(name, "").strip() for name in
               ("OPERATOR_NAME", "OPERATOR_ADDRESS", "OPERATOR_CONTACT", "PRIVACY_POLICY_VERSION"))


def consent_text():
    if not operator_ready():
        raise Conflict("Оператор персональных данных ещё не настроен")
    return (
        f"СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ\n\n"
        f"Я, субъект персональных данных, добровольно, своей волей и в своём интересе даю "
        f"{os.environ['OPERATOR_NAME']}, адрес: {os.environ['OPERATOR_ADDRESS']} (далее — Оператор), "
        "согласие на обработку моих персональных данных для моей идентификации, оформления и исполнения "
        "документов о безвозмездной передаче оборудования во временное пользование, составления акта выдачи "
        "и возврата, проверки комплектности, рассмотрения требований о возмещении утраты или повреждения "
        "оборудования и связи со мной по этим вопросам.\n\n"
        "Перечень данных: фамилия, имя, отчество, дата рождения; серия, номер, дата выдачи, орган выдачи и "
        "код подразделения паспорта; адрес регистрации и фактического проживания; номер студенческого билета и "
        "учебное заведение; Telegram ID, телефон или иной предоставленный контакт; фотографии "
        "разворота паспорта с фотографией, страницы регистрации и лицевой стороны студенческого билета.\n\n"
        "Оператор выполняет сбор, запись, систематизацию, хранение, уточнение, извлечение, использование, "
        "предоставление допущенным сотрудникам, блокирование и уничтожение данных. Фотографии проверяются "
        "сотрудником без OCR; перед сохранением изображения декодируются, пересохраняются без EXIF и шифруются. "
        "Реквизиты и фотографии не передаются в сообщения Telegram и не используются для рекламы.\n\n"
        "Полные данные доступны только сотрудникам, включённым в закрытый список проверки документов. "
        "Анкета и фотографии хранятся во время оформления и исполнения аренды, затем удаляются через 90 дней после возврата оборудования; "
        "если в этот период оформляется новая заявка, введённые реквизиты могут быть предложены для повторного заполнения, "
        "а согласие на обработку для новой заявки запрашивается отдельно. Фотографии документов в новую заявку не переносятся. "
        "При открытом ремонте срок хранения отсчитывается после его закрытия. Данные могут быть удалены раньше при наличии законного основания и обращения. "
        "Запрос, уточнение, отзыв согласия или обращение по удалению можно направить через "
        + os.environ["OPERATOR_CONTACT"] + ". Отказ предоставить данные означает невозможность оформить документы "
        "и передать оборудование во временное пользование. Настоящее согласие оформляется отдельно от расписки "
        "и иных документов о передаче оборудования."
    )


def _master_key():
    raw = os.getenv("PII_MASTER_KEY", "").strip()
    if not raw:
        raise Conflict("Хранилище документов не настроено")
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception as exc:
        raise Conflict("PII_MASTER_KEY имеет неверный формат") from exc
    if len(key) != 32:
        raise Conflict("PII_MASTER_KEY должен содержать 32 байта в base64url")
    return key


def generate_master_key():
    return base64.urlsafe_b64encode(AESGCM.generate_key(bit_length=256)).decode().rstrip("=")


def sanitize_image(raw, declared_type=""):
    if declared_type.lower().split(";", 1)[0].strip() not in {"image/jpeg", "image/png", "image/webp"}:
        raise ValueError("Недопустимый MIME-тип изображения")
    if not raw or len(raw) > MAX_FILE_SIZE:
        raise ValueError("Каждое изображение должно быть не больше 8 МБ")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("Поддерживаются только JPEG, PNG и WebP")
            normalized = ImageOps.exif_transpose(image).convert("RGB")
            output = io.BytesIO()
            normalized.save(output, format="JPEG", quality=90, optimize=True)
            return output.getvalue(), "image/jpeg"
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Файл не является корректным изображением") from exc


def _encrypt_payload(payload, dek):
    nonce = os.urandom(12)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return AESGCM(dek).encrypt(nonce, body, b"polyrental-identity-v1"), nonce


def _decrypt_payload(identity):
    master = _master_key()
    dek = AESGCM(master).decrypt(identity.key_nonce, identity.encrypted_key,
                                 f"booking:{identity.booking_id}".encode())
    body = AESGCM(dek).decrypt(identity.payload_nonce, identity.encrypted_payload,
                               b"polyrental-identity-v1")
    return json.loads(body), dek


def _mask(value, keep=2):
    value = str(value or "")
    return "•" * max(0, len(value) - keep) + value[-keep:]


def identity_status(booking_id, customer_id=None):
    with Session() as session:
        booking = session.get(Booking, booking_id)
        if not booking or (customer_id is not None and booking.customer_id != customer_id):
            raise ValueError("Заявка не найдена")
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
        result = {"booking_id": booking.id, "status": booking.identity_status,
                  "review_comment": identity.review_comment if identity else "",
                  "review_fields": json.loads(identity.review_fields or "[]") if identity else []}
        if identity and customer_id is not None:
            payload, _ = _decrypt_payload(identity)
            result["fields"] = payload
            result["documents"] = sorted(document.kind for document in identity.documents)
        return result


def reusable_identity_fields(booking_id, customer_id):
    """Return the customer's latest still-retained identity fields for prefill.

    Document photos are deliberately not reused: a new application must include
    its own current images. Active bookings retain their identity until return;
    returned bookings are eligible only until their configured deletion date.
    """
    active_statuses = {"pending", "confirmed", "preparing", "ready", "issued", "return_inspection"}
    with Session.begin() as session:
        target = session.get(Booking, booking_id)
        if not target or target.customer_id != customer_id:
            raise ValueError("Заявка не найдена")
        eligible = or_(
            and_(Booking.status.in_(active_statuses), CustomerIdentity.delete_after.is_(None)),
            and_(Booking.status == "returned", CustomerIdentity.delete_after > now()),
            and_(Booking.status == "returned", exists(select(RepairTicket.id).where(
                RepairTicket.booking_id == Booking.id, RepairTicket.status != "closed"))),
        )
        identity = session.scalar(
            select(CustomerIdentity)
            .join(Booking, Booking.id == CustomerIdentity.booking_id)
            .where(CustomerIdentity.customer_id == customer_id,
                   CustomerIdentity.booking_id != booking_id,
                   CustomerIdentity.status.in_({"submitted", "needs_changes", "verified"}),
                   eligible)
            .order_by(CustomerIdentity.updated_at.desc(), CustomerIdentity.id.desc())
            .limit(1)
        )
        if identity is None:
            return {"reusable": False, "fields": {}}
        payload, _ = _decrypt_payload(identity)
        session.add(PIIAudit(booking_id=booking_id, actor_id=customer_id,
                             action="identity_prefilled"))
        return {"reusable": True, "fields": payload}


def submit_identity(booking_id, customer_id, payload, documents, policy_version="", text_hash=""):
    if not isinstance(payload, dict):
        raise ValueError("Неверный формат анкеты")
    with Session() as lookup:
        existing = lookup.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        existing_payload = _decrypt_payload(existing)[0] if existing and existing.status == "needs_changes" else {}
        existing_kinds = {document.kind for document in existing.documents} if existing and existing.status == "needs_changes" else set()
    merged_payload = {**existing_payload, **payload}
    payload = validate_identity_payload(merged_payload,
                                        legacy_institution=existing_payload.get("student_institution"))
    if existing_payload:
        if not documents and not existing_kinds:
            raise ValueError("Загрузите исправленное изображение документа")
    elif set(documents) != DOCUMENT_KINDS:
        raise ValueError("Нужны три изображения документов")
    if sum(len(data[0]) for data in documents.values()) > MAX_TOTAL_SIZE:
        raise ValueError("Общий размер комплекта документов превышает 32 МБ")
    if not existing_payload:
        expected_text = consent_text()
        expected_hash = hashlib.sha256(expected_text.encode()).hexdigest()
        if policy_version != os.environ["PRIVACY_POLICY_VERSION"] or text_hash != expected_hash:
            raise Conflict("Текст согласия изменился. Откройте форму заново")
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        if not booking or booking.customer_id != customer_id or booking.status not in {
            "confirmed", "preparing", "ready"
        }:
            raise ValueError("Документы недоступны для этой заявки")
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking.id))
        if identity and identity.status == "verified":
            raise Conflict("Проверенные документы нельзя заменить без запроса менеджера")
        if booking.identity_status not in {"required", "needs_changes"}:
            raise Conflict("Отправка документов недоступна в текущем состоянии")
        old_documents = {}
        if identity and identity.status == "needs_changes":
            required_images = set(json.loads(identity.review_fields or "[]")) & DOCUMENT_KINDS
            if not required_images.issubset(documents):
                raise ValueError("Загрузите фотографии, для которых оператор запросил исправления")
            _, old_dek = _decrypt_payload(identity)
            for document in identity.documents:
                old_documents[document.kind] = (AESGCM(old_dek).decrypt(document.nonce, document.encrypted_data,
                    f"{booking.id}:{document.kind}".encode()), document.media_type)
        documents = {**old_documents, **documents}
        if set(documents) != DOCUMENT_KINDS:
            raise ValueError("Нужны три изображения документов")
        dek = AESGCM.generate_key(bit_length=256)
        encrypted_payload, payload_nonce = _encrypt_payload(payload, dek)
        key_nonce = os.urandom(12)
        wrapped = AESGCM(_master_key()).encrypt(key_nonce, dek, f"booking:{booking.id}".encode())
        if identity is None:
            identity = CustomerIdentity(booking_id=booking.id, customer_id=customer_id,
                                        encrypted_key=wrapped, key_nonce=key_nonce,
                                        encrypted_payload=encrypted_payload, payload_nonce=payload_nonce)
            session.add(identity)
            session.flush()
        else:
            session.execute(delete(IdentityDocument).where(IdentityDocument.identity_id == identity.id))
            identity.encrypted_key, identity.key_nonce = wrapped, key_nonce
            identity.encrypted_payload, identity.payload_nonce = encrypted_payload, payload_nonce
        identity.status, identity.review_comment, identity.review_fields, identity.delete_after = "submitted", "", "[]", None
        for kind, (data, media_type) in documents.items():
            nonce = os.urandom(12)
            encrypted = AESGCM(dek).encrypt(nonce, data, f"{booking.id}:{kind}".encode())
            session.add(IdentityDocument(identity_id=identity.id, kind=kind, media_type=media_type,
                                         encrypted_data=encrypted, nonce=nonce, size=len(data)))
        consent = session.scalar(select(PrivacyConsent).where(PrivacyConsent.booking_id == booking.id))
        if consent is None:
            session.add(PrivacyConsent(booking_id=booking.id, customer_id=customer_id,
                                       policy_version=policy_version, text_hash=text_hash))
        elif policy_version and text_hash:
            consent.policy_version, consent.text_hash, consent.consented_at = policy_version, text_hash, now()
        booking.identity_status = "submitted"
        session.add(PIIAudit(booking_id=booking.id, actor_id=customer_id, action="submitted"))


def masked_identity(booking_id, actor_id):
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not identity:
            raise ValueError("Анкета не найдена")
        payload, _ = _decrypt_payload(identity)
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="view_masked"))
        return {
            "status": identity.status, "full_name": payload.get("full_name", ""),
            "passport": _mask(payload.get("passport_number"), 2),
            "student_id": _mask(payload.get("student_id_number"), 2),
            "review_comment": identity.review_comment,
            "review_fields": json.loads(identity.review_fields or "[]"),
            "documents": [document.kind for document in identity.documents],
        }


def reveal_identity(booking_id, actor_id):
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not identity:
            raise ValueError("Анкета не найдена")
        payload, _ = _decrypt_payload(identity)
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="revealed"))
        return {**payload, "status": identity.status, "review_comment": identity.review_comment,
                "review_fields": json.loads(identity.review_fields or "[]")}


def identity_document(booking_id, kind, actor_id):
    if kind not in DOCUMENT_KINDS:
        raise ValueError("Неизвестный документ")
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not identity:
            raise ValueError("Анкета не найдена")
        document = session.scalar(select(IdentityDocument).where(
            IdentityDocument.identity_id == identity.id, IdentityDocument.kind == kind))
        if not document:
            raise ValueError("Изображение не найдено")
        _, dek = _decrypt_payload(identity)
        data = AESGCM(dek).decrypt(document.nonce, document.encrypted_data,
                                   f"{booking_id}:{kind}".encode())
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="document_downloaded"))
        return data, document.media_type


def review_identity(booking_id, actor_id, approved, comment="", fields=None):
    with Session.begin() as session:
        booking = session.scalar(select(Booking).where(Booking.id == booking_id).with_for_update())
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not booking or not identity:
            raise ValueError("Анкета не найдена")
        if booking.status not in {"confirmed", "preparing", "ready"} or identity.status not in {
            "submitted", "needs_changes", "verified"
        }:
            raise ValueError("Проверка анкеты недоступна в текущем состоянии")
        identity.status = "verified" if approved else "needs_changes"
        allowed = {"full_name", "birth_date", "passport_combined", "passport_issued_at", "passport_issuer",
                   "passport_division_code", "registration_address", "residential_address", "student_id_number",
                   "student_institution", "passport_main", "passport_registration", "student_front"}
        identity.review_comment = comment.strip()[:500]
        identity.review_fields = json.dumps([field for field in (fields or []) if field in allowed], ensure_ascii=False)
        booking.identity_status = identity.status
        if not approved:
            booking.act_signed_at = booking.act_signed_by = None
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id,
                             action="verified" if approved else "changes_requested"))


def delete_identity(booking_id, actor_id, reason="manual_delete"):
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        booking = session.get(Booking, booking_id)
        if not identity:
            return False
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action=reason))
        session.delete(identity)
        if booking:
            booking.identity_status = "deleted"
            booking.act_signed_at = booking.act_signed_by = None
        return True


def block_identity(booking_id, actor_id, blocked=True):
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(
            CustomerIdentity.booking_id == booking_id))
        booking = session.get(Booking, booking_id)
        if not identity or not booking:
            raise ValueError("Анкета не найдена")
        identity.status = "blocked" if blocked else "needs_changes"
        booking.identity_status = identity.status
        booking.act_signed_at = booking.act_signed_by = None
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id,
                             action="blocked" if blocked else "unblocked"))


def purge_expired_identities():
    purged = 0
    with Session.begin() as session:
        identities = session.scalars(select(CustomerIdentity).where(
            CustomerIdentity.delete_after.is_not(None), CustomerIdentity.delete_after <= now())).all()
        for identity in identities:
            open_repair = session.scalar(select(RepairTicket.id).where(
                RepairTicket.booking_id == identity.booking_id, RepairTicket.status != "closed").limit(1))
            if open_repair:
                identity.delete_after = now() + timedelta(days=1)
                continue
            booking = session.get(Booking, identity.booking_id)
            session.add(PIIAudit(booking_id=identity.booking_id, actor_id=0, action="retention_purge"))
            session.delete(identity)
            if booking:
                booking.identity_status = "deleted"
            purged += 1
    return purged
