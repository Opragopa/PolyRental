"""Russian labels for chat screens; callback and database values stay stable."""

BOOKING_STATUSES = {
    'pending': 'Ожидает проверки', 'needs_changes': 'Нужно исправить',
    'confirmed': 'Подтверждена', 'preparing': 'Комплектуется',
    'ready': 'Готова к выдаче', 'issued': 'В аренде',
    'return_inspection': 'Возврат на проверке', 'returned': 'Завершена',
    'cancelled': 'Отменена', 'expired': 'Срок удержания истёк',
}
SUPPORT_STATUSES = {'new': 'Новое', 'in_progress': 'В работе', 'resolved': 'Закрыто'}
EQUIPMENT_CONDITIONS = {'available': 'Доступен', 'maintenance': 'На ремонте', 'retired': 'Выведен из эксплуатации'}
STAFF_ROLES = {'operator': 'Оператор', 'manager': 'Менеджер', 'admin': 'Администратор'}
INSPECTION_PROFILES = {'generic': 'Общая', 'camera': 'Камеры', 'optics': 'Оптика', 'light': 'Свет', 'battery': 'Аккумуляторы'}
DELETION_TARGETS = {'request': 'заявка', 'line': 'позиция', 'asset': 'экземпляр'}


def staff_role(value):
    return STAFF_ROLES.get(value, 'Без роли')


def booking_status(value):
    return BOOKING_STATUSES.get(value, 'Статус уточняется')


def support_status(value):
    return SUPPORT_STATUSES.get(value, 'Статус уточняется')


def equipment_condition(value):
    return EQUIPMENT_CONDITIONS.get(value, 'Состояние уточняется')
