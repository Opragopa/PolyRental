"""Telegram-safe status updates shared by the bot and Mini App."""

import html


STATUS_LABELS = {
    "pending": "возвращена на проверку менеджера",
    "confirmed": "подтверждена — заполните документы в приложении",
    "preparing": "передана в подготовку",
    "ready": "готова к выдаче",
    "issued": "оборудование выдано",
    "return_inspection": "оборудование принято на проверку",
    "returned": "Заявка завершена",
    "cancelled": "отменена",
    "identity_verified": "документы проверены",
    "identity_needs_changes": "документы требуют исправления — откройте приложение",
}

CARD_HEADINGS = {
    "pending": "Заявка на проверке",
    "needs_changes": "Нужно исправить заявку",
    "confirmed": "Бронирование подтверждено",
    "preparing": "Оборудование готовится к выдаче",
    "ready": "Оборудование готово к выдаче",
    "issued": "Оборудование выдано",
    "return_inspection": "Возврат на проверке",
    "returned": "Аренда завершена",
    "cancelled": "Заявка отменена",
    "expired": "Срок заявки истёк",
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
    stage = html.escape(STAGE_LABELS.get(status, "Обновление заявки"))
    state = html.escape(STATUS_LABELS.get(status, "статус уточняется"))
    if status == "cancelled":
        state = f"<s>{state}</s>"
    operator = html.escape(" ".join(operator_name.split())[:160] or "не указан")
    return (f"<b>Обновление по заявке №{booking_id}</b>\n"
            f"Этап: <b>{stage}</b>\n"
            f"Оператор: <b>{operator}</b>\n"
            f"Статус: {state}.")
