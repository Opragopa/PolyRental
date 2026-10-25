"""Encrypted identity profiles and document images.

No plaintext identity value is logged or persisted outside the encrypted payload.
"""

import base64
import hashlib
import io
import json
import os
from datetime import timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image, UnidentifiedImageError
from sqlalchemy import delete, select

from .db import (Booking, CustomerIdentity, IdentityDocument, PIIAudit, PrivacyConsent,
                 RepairTicket, Session)
from .rental import Conflict, now


DOCUMENT_KINDS = {"passport_main", "passport_registration", "student_front", "student_back"}
MAX_FILE_SIZE = 8 * 1024 * 1024
MAX_TOTAL_SIZE = 32 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 30_000_000


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
        "код подразделения паспорта; адрес регистрации и фактического проживания; номер студенческого билета, "
        "учебное заведение и срок действия; Telegram ID, телефон или иной предоставленный контакт; фотографии "
        "разворота паспорта с фотографией, страницы регистрации и обеих сторон студенческого билета.\n\n"
        "Оператор выполняет сбор, запись, систематизацию, хранение, уточнение, извлечение, использование, "
        "предоставление допущенным сотрудникам, блокирование и уничтожение данных. Фотографии проверяются "
        "сотрудником без OCR; перед сохранением изображения декодируются, пересохраняются без EXIF и шифруются. "
        "Реквизиты и фотографии не передаются в сообщения Telegram и не используются для рекламы.\n\n"
        "Полные данные доступны только сотрудникам, включённым в закрытый список проверки документов. "
        "Данные удаляются по утверждённым срокам хранения или раньше при наличии законного основания и обращения. "
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
            normalized = image.convert("RGB")
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
        return {"booking_id": booking.id, "status": booking.identity_status,
                "review_comment": session.scalar(select(CustomerIdentity.review_comment).where(
                    CustomerIdentity.booking_id == booking.id)) or ""}


def submit_identity(booking_id, customer_id, payload, documents, policy_version, text_hash):
    if set(documents) != DOCUMENT_KINDS:
        raise ValueError("Нужны все четыре изображения документов")
    if sum(len(data[0]) for data in documents.values()) > MAX_TOTAL_SIZE:
        raise ValueError("Общий размер комплекта документов превышает 32 МБ")
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
        identity.status, identity.review_comment, identity.delete_after = "submitted", "", None
        for kind, (data, media_type) in documents.items():
            nonce = os.urandom(12)
            encrypted = AESGCM(dek).encrypt(nonce, data, f"{booking.id}:{kind}".encode())
            session.add(IdentityDocument(identity_id=identity.id, kind=kind, media_type=media_type,
                                         encrypted_data=encrypted, nonce=nonce, size=len(data)))
        consent = session.scalar(select(PrivacyConsent).where(PrivacyConsent.booking_id == booking.id))
        if consent is None:
            session.add(PrivacyConsent(booking_id=booking.id, customer_id=customer_id,
                                       policy_version=policy_version, text_hash=text_hash))
        else:
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
            "documents": [document.kind for document in identity.documents],
        }


def reveal_identity(booking_id, actor_id):
    with Session.begin() as session:
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not identity:
            raise ValueError("Анкета не найдена")
        payload, _ = _decrypt_payload(identity)
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action="revealed"))
        return {**payload, "status": identity.status, "review_comment": identity.review_comment}


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


def review_identity(booking_id, actor_id, approved, comment=""):
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if not booking or not identity:
            raise ValueError("Анкета не найдена")
        identity.status = "verified" if approved else "needs_changes"
        identity.review_comment = comment.strip()[:500]
        booking.identity_status = identity.status
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
