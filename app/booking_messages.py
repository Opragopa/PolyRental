"""Telegram-safe status updates shared by the bot and Mini App."""

import html


STATUS_LABELS = {
    "pending": "возвращена на проверку менеджера",
    "confirmed": "подтверждена — заполните документы в Mini App",
    "preparing": "передана в подготовку",
    "ready": "готова к выдаче",
    "issued": "оборудование выдано",
    "return_inspection": "оборудование принято на проверку",
    "returned": "возврат завершён",
    "cancelled": "отменена",
    "identity_verified": "документы проверены",
    "identity_needs_changes": "документы требуют исправления — откройте Mini App",
}

STAGE_LABELS = {
    "pending": "Возврат на доработку",
    "confirmed": "Подтверждение заявки",
    "preparing": "Подготовка оборудования",
    "ready": "Проверка готовности",
    "issued": "Выдача оборудования",
    "return_inspection": "Приём оборудования",
    "returned": "Завершение возврата",
    "cancelled": "Отмена заявки",
    "identity_verified": "Проверка анкеты",
    "identity_needs_changes": "Проверка анкеты",
}


def booking_status_text(booking_id: int, status: str, operator_name: str) -> str:
    """Name the completed workflow step and the operator who performed it."""
    stage = html.escape(STAGE_LABELS.get(status, status))
    state = html.escape(STATUS_LABELS.get(status, status))
    if status == "cancelled":
        state = f"<s>{state}</s>"
    operator = html.escape(" ".join(operator_name.split())[:160] or "не указан")
    return (f"<b>Обновление по заявке №{booking_id}</b>\n"
            f"Этап: <b>{stage}</b>\n"
            f"Оператор: <b>{operator}</b>\n"
            f"Статус: {state}.")
