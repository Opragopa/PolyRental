"""Versioned carts are scoped to the authenticated Telegram user."""
from sqlalchemy import text
from .db import BookingCart, Session


class CartConflict(Exception):
    pass


def _view(cart):
    return {'start': cart.starts_at, 'end': cart.ends_at, 'lines': cart.lines, 'version': cart.version}


def get_cart(user_id):
    with Session.begin() as session:
        session.execute(text('INSERT INTO booking_carts (telegram_id) VALUES (:id) ON CONFLICT DO NOTHING'), {'id':user_id})
        return _view(session.get(BookingCart, user_id))


def put_cart(user_id, start, end, lines, version):
    with Session.begin() as session:
        session.execute(text('INSERT INTO booking_carts (telegram_id) VALUES (:id) ON CONFLICT DO NOTHING'), {'id':user_id})
        cart = session.get(BookingCart, user_id, with_for_update=True)
        if cart.version != version:
            raise CartConflict('Подборка изменилась на другом устройстве. Обновите приложение и проверьте выбор.')
        cart.starts_at, cart.ends_at, cart.lines = start, end, lines
        cart.version += 1
        session.execute(text('UPDATE booking_carts SET updated_at=now() WHERE telegram_id=:id'), {'id':user_id})
        return _view(cart)
