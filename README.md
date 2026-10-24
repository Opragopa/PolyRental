# PolyRental

Telegram-бот для аренды оборудования: поиск по датам, временное удержание на 30 минут, подтверждение менеджером, панель учета, документы DOCX и календарь iCal. Время клиента — Europe/Moscow. Интервалы `[начало, конец)`; возврат точно в момент следующей выдачи допустим.

## Запуск

1. Скопируйте `.env.example` в `.env`. Укажите `BOT_TOKEN`, `BOT_USERNAME` (имя бота без `@`), `ADMIN_IDS` (Telegram ID менеджеров через запятую), надежные разные `SESSION_SECRET` и `ICAL_TOKEN`, а также публичный HTTPS `PUBLIC_URL` для Telegram Login Widget. Для реального развертывания задайте `POSTGRES_PASSWORD` отдельно; согласуйте его с `DATABASE_URL`, если запускаете приложение вне Compose.
2. Выполните `docker compose up -d --build`. Панель доступна по `/login`, проверка готовности — `/health`. Команда `docker compose logs -f web bot` показывает запуск. Для локальной проверки без Telegram-токена можно запустить только `db web`.
   В управляемом облаке Codex используйте `BUILDX_CONFIG=/workspace/.buildx docker compose -f compose.yaml -f compose.cloud.yaml up -d --build db web`; файл `compose.cloud.yaml` передает CA прокси только на шаг установки пакетов.
3. Менеджер добавляет экземпляры в `/admin/equipment` или командой `/add НОМЕР ЦЕНА НАЗВАНИЕ`; обновляет через панель или `/set ID НОМЕР ЦЕНА СОСТОЯНИЕ НАЗВАНИЕ`. Клиент отправляет `/book` и выбирает сроки, ID экземпляров, имя и контакт. Менеджер использует `/bookings`, `/confirm ID`, `/cancel ID`, `/issue ID`, `/return ID` либо кнопки панели.

Шаблоны `templates/contract.docx`, `templates/issue.docx`, `templates/return.docx` создаются при первом старте, если их нет. Их можно редактировать как обычные DOCX, сохраняя имена переменных Jinja (`booking_id`, `customer_name`, `customer_contact`, `starts_at`, `ends_at`, `equipment`, `total`). Каталог сохраняется в томе Compose. Ссылка iCal доступна в календаре панели; любой обладатель ссылки может читать названия оборудования и сроки подтвержденных броней, поэтому храните токен конфиденциально.

Тесты: `docker compose run --rm test`. Compose создает для них отдельную БД `polyrental_test`. В облаке Codex сначала соберите тестовый образ с CA: `BUILDX_CONFIG=/workspace/.buildx docker compose -f compose.yaml -f compose.cloud.yaml build test`, затем выполните `docker compose -f compose.yaml -f compose.cloud.yaml run --rm test`.
