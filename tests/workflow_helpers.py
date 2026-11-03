"""Synthetic identities and explicit attestations for workflow tests."""
import os
import base64

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from app.db import Booking, CustomerIdentity, Session, TrustedSigner
from app.pii import _encrypt_payload, _master_key
from app.handover import attest_paper_signature, customer_attest


def verified_identity(booking_id):
    os.environ.setdefault("PII_MASTER_KEY", base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("="))
    with Session.begin() as session:
        booking = session.get(Booking, booking_id)
        identity = session.scalar(select(CustomerIdentity).where(CustomerIdentity.booking_id == booking_id))
        if identity is None:
            dek, nonce = AESGCM.generate_key(bit_length=256), os.urandom(12)
            payload, payload_nonce = _encrypt_payload({"full_name": "Тестовый Получатель", "passport_series": "0000",
                "passport_number": "123456", "passport_issued_at": "2020-01-01", "passport_issuer": "Тестовый отдел",
                "registration_address": "Тестовый адрес", "residential_address": "Тестовый адрес"}, dek)
            identity = CustomerIdentity(booking_id=booking.id, customer_id=booking.customer_id,
                encrypted_key=AESGCM(_master_key()).encrypt(nonce, dek, f"booking:{booking.id}".encode()), key_nonce=nonce,
                encrypted_payload=payload, payload_nonce=payload_nonce, status="verified")
            session.add(identity)
        identity.status, booking.identity_status = "verified", "verified"


def paper(booking_id, actor_id=100, point="issue"):
    with Session.begin() as session:
        signer = session.get(TrustedSigner, actor_id)
        if signer is None:
            session.add(TrustedSigner(telegram_id=actor_id, full_name="Тестовый Сотрудник", active=True))
        customer_id = session.get(Booking, booking_id).customer_id
    attest_paper_signature(booking_id, actor_id, point, True, True)


def returning(booking_id):
    with Session() as session:
        customer_id = session.get(Booking, booking_id).customer_id
    customer_attest(booking_id, customer_id, "returning")
