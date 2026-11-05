"""Encrypted asynchronous support; audit metadata contains no message text."""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, exists, func, select, text
from .db import Audit, Booking, PIIAudit, RepairTicket, Session, SupportActivity, SupportMessage, SupportThread
from .pii import _master_key
from .roles import staff_allows, configured_ids


class SupportConflict(Exception):
    pass


def _seal(thread_id, sender_id, direction, message):
    nonce = os.urandom(12)
    aad = f'support-v1:{thread_id}:{sender_id}:{direction}'.encode()
    return AESGCM(_master_key()).encrypt(nonce, message.encode(), aad), nonce


def _open(message):
    aad = f'support-v1:{message.thread_id}:{message.sender_id}:{message.direction}'.encode()
    return AESGCM(_master_key()).decrypt(message.nonce, message.ciphertext, aad).decode()


def submit_question(customer_id, booking_id, screen, question):
    question = question.strip()
    if not question or len(question) > 3000 or screen not in {'profile', 'booking', 'request', 'bot', 'feedback'}:
        raise ValueError('Укажите вопрос длиной до 3000 символов')
    with Session.begin() as session:
        booking = session.get(Booking, booking_id) if booking_id is not None else None
        if booking_id is not None and (not booking or booking.customer_id != customer_id or booking.deleted_at is not None):
            raise ValueError('Заявка не найдена')
        number = (booking.human_number or f'legacy-{booking.id}') if booking else ''
        session.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))'), {'key':f'support:{customer_id}:{number}'})
        thread = session.scalar(select(SupportThread).where(SupportThread.customer_id == customer_id,
                                                            SupportThread.request_number == number).with_for_update())
        eligible_assignee = booking.assignee_id if booking and booking.assignee_id in configured_ids("PII_ADMIN_IDS") and staff_allows(booking.assignee_id, "operator") else None
        if thread is None:
            thread = SupportThread(customer_id=customer_id, booking_id=booking_id, request_number=number,
                                   screen=screen, owner_id=eligible_assignee, status='new')
            session.add(thread)
            session.flush()
            session.add(SupportActivity(thread_id=thread.id, actor_id=customer_id, action='created'))
        elif thread.status == 'resolved':
            thread.status = 'new'
            thread.resolved_at = None
            session.add(SupportActivity(thread_id=thread.id, actor_id=customer_id, action='reopened'))
        if thread.owner_id is None and eligible_assignee:
            thread.owner_id = eligible_assignee
            session.add(SupportActivity(thread_id=thread.id, actor_id=customer_id, action='routed_to_assignee'))
        message = f"Предложение по приложению:\n{question}" if screen == 'feedback' else question
        encrypted, nonce = _seal(thread.id, customer_id, 'client', message)
        session.add(SupportMessage(thread_id=thread.id, sender_id=customer_id, direction='client', ciphertext=encrypted, nonce=nonce))
        session.add(SupportActivity(thread_id=thread.id, actor_id=customer_id, action='client_message'))
        return {'id':thread.id, 'owner_id':thread.owner_id, 'request_number':number}


def support_threads_page(customer_id=None, page=0, page_size=20, thread_id=None):
    if page < 0 or not 1 <= page_size <= 100:
        raise ValueError('Неверная страница обращений')
    conditions = []
    if customer_id is not None:
        conditions.append(SupportThread.customer_id == customer_id)
    if thread_id is not None:
        conditions.append(SupportThread.id == thread_id)
    responded = exists(select(SupportMessage.id).where(SupportMessage.thread_id == SupportThread.id,
        SupportMessage.direction == 'operator', SupportMessage.delivered_at.is_not(None)))
    with Session() as session:
        total = session.scalar(select(func.count()).select_from(SupportThread).where(*conditions))
        rows = session.execute(select(SupportThread, responded.label('responded')).where(*conditions)
            .order_by(SupportThread.created_at.desc(), SupportThread.id.desc()).offset(page * page_size).limit(page_size)).all()
        return [{'id':row.id, 'request_number':row.request_number, 'status':row.status,
                 'owner_id':row.owner_id, 'screen':row.screen, 'created_at':row.created_at.isoformat(),
                 'customer_state':'Оператор ответил' if responded else 'Обращение получено'} for row, responded in rows], total


def list_threads(owner_id=None, customer_id=None):
    # Preserve the existing unpaged API contract for older bot and site clients.
    return support_threads_page(customer_id=customer_id, page_size=100)[0]


def claim_thread(thread_id, actor_id):
    with Session.begin() as session:
        thread = session.scalar(select(SupportThread).where(SupportThread.id == thread_id).with_for_update())
        if not thread:
            raise ValueError('Обращение не найдено')
        if thread.status == 'resolved':
            raise SupportConflict('Обращение закрыто')
        if thread.owner_id is not None and thread.owner_id != actor_id:
            raise SupportConflict('Обращение уже закреплено за другим оператором')
        if thread.owner_id is None:
            thread.owner_id = actor_id
            session.add(SupportActivity(thread_id=thread.id, actor_id=actor_id, action='claimed'))
        thread.status = 'in_progress'


def reassign_thread(thread_id, actor_id, new_owner):
    if new_owner not in configured_ids("PII_ADMIN_IDS") or not staff_allows(new_owner, "operator"):
        raise ValueError("Назначить можно только сотрудника с доступом к персональным данным")
    with Session.begin() as session:
        thread = session.scalar(select(SupportThread).where(SupportThread.id == thread_id).with_for_update())
        if not thread:
            raise ValueError('Обращение не найдено')
        if thread.status == 'resolved':
            raise SupportConflict('Обращение закрыто')
        if thread.owner_id != actor_id and actor_id not in configured_ids('ADMIN_IDS'):
            raise SupportConflict('Переназначить обращение может владелец или администратор')
        if thread.owner_id != new_owner:
            thread.owner_id = new_owner
            session.add(SupportActivity(thread_id=thread.id, actor_id=actor_id, action=f'owner:{new_owner}'))


def read_messages(thread_id, actor_id):
    with Session.begin() as session:
        thread = session.get(SupportThread, thread_id)
        if not thread:
            raise ValueError('Обращение не найдено')
        if thread.owner_id != actor_id:
            raise SupportConflict('Обращение закреплено за другим оператором')
        session.add(PIIAudit(booking_id=thread.booking_id, actor_id=actor_id, action='support_read'))
        session.add(SupportActivity(thread_id=thread.id, actor_id=actor_id, action='messages_read'))
        rows = session.scalars(select(SupportMessage).where(SupportMessage.thread_id == thread_id).order_by(SupportMessage.id)).all()
        return {'customer_id': thread.customer_id, 'request_number': thread.request_number, 'screen': thread.screen,
                'items': [{'id':row.id, 'direction':row.direction, 'text':_open(row), 'created_at':row.created_at.isoformat()} for row in rows]}


def reply(thread_id, actor_id, body):
    body = body.strip()
    if not body or len(body) > 3000:
        raise ValueError('Введите ответ длиной до 3000 символов')
    with Session.begin() as session:
        thread = session.scalar(select(SupportThread).where(SupportThread.id == thread_id).with_for_update())
        if not thread:
            raise ValueError('Обращение не найдено')
        if thread.owner_id != actor_id or thread.status == 'resolved':
            raise SupportConflict('Ответ доступен владельцу открытого обращения')
        encrypted, nonce = _seal(thread.id, actor_id, 'operator', body)
        message = SupportMessage(thread_id=thread.id, sender_id=actor_id, direction='operator', ciphertext=encrypted, nonce=nonce)
        session.add(message)
        session.add(PIIAudit(booking_id=thread.booking_id, actor_id=actor_id, action='support_reply'))
        session.add(SupportActivity(thread_id=thread.id, actor_id=actor_id, action='operator_reply'))
        thread.status = 'in_progress'
        session.flush()
        return message.id


def resolve_thread(thread_id, actor_id):
    with Session.begin() as session:
        thread = session.scalar(select(SupportThread).where(SupportThread.id == thread_id).with_for_update())
        if not thread:
            raise ValueError('Обращение не найдено')
        if thread.owner_id != actor_id:
            raise SupportConflict('Закрыть обращение может его владелец')
        if thread.status != 'resolved':
            latest_client = session.scalar(select(func.max(SupportMessage.id)).where(SupportMessage.thread_id == thread_id, SupportMessage.direction == "client"))
            answered = session.scalar(select(SupportMessage.id).where(SupportMessage.thread_id == thread_id, SupportMessage.direction == "operator", SupportMessage.id > (latest_client or 0), SupportMessage.delivered_at.is_not(None)).limit(1))
            if not answered:
                raise SupportConflict("Сначала отправьте ответ клиенту или передайте обращение")
            thread.status = 'resolved'
            thread.resolved_at = datetime.now(timezone.utc)
            session.add(SupportActivity(thread_id=thread.id, actor_id=actor_id, action='resolved'))


def purge_support_for_booking(session, booking_id, actor_id, reason):
    thread_ids = select(SupportThread.id).where(SupportThread.booking_id == booking_id)
    result = session.execute(delete(SupportMessage).where(SupportMessage.thread_id.in_(thread_ids)))
    if result.rowcount:
        session.add(PIIAudit(booking_id=booking_id, actor_id=actor_id, action=reason))
    return result.rowcount


def purge_expired_support(at=None):
    """Clear resolved message content after the applicable retention period."""
    at = at or datetime.now(timezone.utc)
    purged = 0
    with Session.begin() as session:
        threads = session.scalars(select(SupportThread).where(SupportThread.status == 'resolved',
                                  SupportThread.resolved_at.is_not(None)).with_for_update(skip_locked=True)).all()
        for thread in threads:
            booking = session.get(Booking, thread.booking_id) if thread.booking_id else None
            if booking:
                if session.scalar(select(RepairTicket.id).where(RepairTicket.booking_id == booking.id, RepairTicket.status != 'closed').limit(1)):
                    continue
                if booking.status == 'cancelled' and booking.returned_at is None:
                    cancelled_at = session.scalar(select(func.max(Audit.created_at)).where(Audit.booking_id == booking.id, Audit.action == 'cancelled'))
                    deadline = max(thread.resolved_at, cancelled_at) + timedelta(hours=24) if cancelled_at else None
                elif booking.returned_at is not None:
                    closed_at = session.scalar(select(func.max(RepairTicket.closed_at)).where(RepairTicket.booking_id == booking.id))
                    deadline = max(x for x in (thread.resolved_at, booking.returned_at, closed_at) if x is not None) + timedelta(days=90)
                else:
                    continue
            else:
                deadline = thread.resolved_at + timedelta(days=90)
            if deadline is not None and at >= deadline:
                count = session.execute(delete(SupportMessage).where(SupportMessage.thread_id == thread.id)).rowcount
                if count:
                    session.add(PIIAudit(booking_id=thread.booking_id, actor_id=0, action='support_retention_purge'))
                    session.add(SupportActivity(thread_id=thread.id, actor_id=0, action='content_purged'))
                    purged += count
    return purged


async def deliver_reply(message_id):
    token = os.getenv('BOT_TOKEN', '')
    if not token:
        return False
    from .bot import make_bot
    with Session.begin() as session:
        row = session.scalar(select(SupportMessage).where(SupportMessage.id == message_id,
                            SupportMessage.direction == 'operator').with_for_update(skip_locked=True))
        if row is None or row.delivered_at is not None:
            return row is not None
        thread = session.get(SupportThread, row.thread_id)
        body = _open(row)
        try:
            async with make_bot(token) as bot:
                await asyncio.wait_for(bot.send_message(thread.customer_id, f'Ответ оператора:\n{body}', parse_mode=None), timeout=10)
        except Exception:
            return False
        row.delivered_at = datetime.now(timezone.utc)
        return True


async def retry_support_replies():
    with Session() as session:
        ids = session.scalars(select(SupportMessage.id).where(SupportMessage.direction == 'operator',
                              SupportMessage.delivered_at.is_(None)).order_by(SupportMessage.id).limit(50)).all()
    for message_id in ids:
        await deliver_reply(message_id)
