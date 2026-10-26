# PolyRental

Telegram-бот и ролевая Mini App для аренды оборудования. Клиент бронирует артикулы и количество, а конкретные экземпляры и серийные номера назначаются при подготовке. Время клиента — Europe/Moscow; после возврата действует настраиваемый буфер артикула (по умолчанию 24 часа).

Текущий выпуск — [v0.1.13](docs/releases/v0.1.13.md). Версия задаётся в `VERSION`, отображается рядом с названием в Mini App и возвращается в `/health`; ею же помечаются URL JS/CSS для обновления кеша.

Стратегия роста БД и хранения вложений описана в [docs/storage-and-retention.md](docs/storage-and-retention.md).

Для адресных подсказок анкеты задайте `DADATA_API_KEY` в серверном `.env`. Ключ хранится только на сервере; при его отсутствии адрес остаётся доступен для ручного ввода.

## Запуск

1. Скопируйте `.env.example` в `.env`. Укажите `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_IDS`, отдельный список `PII_ADMIN_IDS`, надёжные разные `SESSION_SECRET` и `ICAL_TOKEN`, публичный HTTPS `PUBLIC_URL` и параметры оператора ПД. `PII_MASTER_KEY` — случайный 32-байтный ключ в base64url; его нельзя хранить в Git или терять. В @BotFather настройте домен и Main Mini App на `PUBLIC_URL/miniapp`.
2. Для режима **бот + Mini App без панели сайта** выполните `docker compose -f compose.yaml -f compose.miniapp.yaml up -d --build`. Mini App доступна по `/miniapp`, проверка готовности — `/health`; сервис панели `web` в этом режиме не запускается. Если ранее был запущен `web` на порту 8000, остановите его командой `docker compose stop web`. Журналы: `docker compose -f compose.yaml -f compose.miniapp.yaml logs -f miniapp bot`.
   Для старого режима с панелью используйте `docker compose up -d --build db web bot`; панель доступна по `/login`.
   В управляемом облаке Codex используйте `BUILDX_CONFIG=/workspace/.buildx docker compose -f compose.yaml -f compose.cloud.yaml up -d --build db web`; файл `compose.cloud.yaml` передает CA прокси только на шаг установки пакетов.
3. Основное управление находится во вкладке «Управление» Mini App: заказы, комплектование, проверки, возврат, каталог и ремонт. Старые `/add` и `/set` сохранены как временный резерв. Команды `/confirm`, `/prepare`, `/ready`, `/issue`, `/checkin`, `/return` подчиняются тем же статусным ограничениям.

### Добавление оборудования

В «Управление → Каталог» сначала создаётся **артикул** — модель, которую видит клиент: SKU, название, описание, ставка, фото, категория, профиль проверки и буфер. Затем внутрь артикула добавляются **экземпляры**: серийный номер, складская ячейка, состояние, а для аккумулятора — здоровье и заряд. Серийные номера клиентскому API не выдаются. Артикул можно скрыть из клиентского каталога без удаления истории, экземпляр — перевести в ремонт или списать. Сейчас бронирование учитывает только явно выбранные позиции; автоматические зависимые позиции временно отключены.

Идемпотентный демонстрационный каталог можно создать командой `docker compose -f compose.yaml -f compose.miniapp.yaml exec -T miniapp python scripts/seed_test_catalog.py`. Все его SKU, названия и серийные номера начинаются с `TEST-`, поэтому их легко отличить от реальной техники и скрыть через форму артикула.

## Mini App

- Для просмотра интерфейса локально откройте `http://localhost:8000/miniapp?preview=1`. Это демонстрация с примером каталога; она не создаёт заявки.
- Реальное бронирование доступно только при открытии через Telegram по публичному HTTPS-адресу. Кнопка клавиатуры отправляет заказ боту через `sendData`; бот берёт ID клиента из сообщения Telegram и повторно проверяет доступность и цену. Запуск через меню или кнопку под сообщением использует серверную проверку подписанных `initData`. Повторная отправка с тем же `request_id` возвращает прежнюю заявку.
- Mini App хранит на устройстве только черновик сроков и количества артикулов; имя, контакт, реквизиты и изображения документов в него не попадают. Удержание начинается при отправке заявки и длится 30 минут.
- После подтверждения заказа клиент отдельно принимает согласие и заполняет защищённую анкету. Изображения нормализуются без EXIF, а анкета и файлы шифруются AES-256-GCM отдельным ключом. Обычные `ADMIN_IDS` не имеют доступа к полным данным.
- В локальном режиме с `PUBLIC_URL=http://localhost:8000` кнопка бота запускает оформление в чате. Telegram Mini App требует публичного HTTPS-адреса, направленного на сервис `miniapp`, и настройки URL в @BotFather. Адрес `localhost` нельзя открыть из Telegram у других пользователей.

### Публикация через Nginx

Для домена `polyrental.cloudopragopa.online` подготовлен Compose-файл `compose.public.yaml`. Из-за уже работающего в Windows Nginx контейнер проекта использует локальные порты 8080 и 8443; сам Mini App доступен напрямую только с этого компьютера по `127.0.0.1:8000`. Панель сайта `web` при таком запуске не включается.

1. Убедитесь, что A-запись домена указывает на внешний IP компьютера или маршрутизатора. На маршрутизаторе создайте правила TCP: внешний порт 80 → `192.168.1.161:8080`, внешний порт 443 → `192.168.1.161:8443`. Разрешите локальные порты 8080 и 8443 в брандмауэре. Для выпуска сертификата путь `http://polyrental.cloudopragopa.online/.well-known/acme-challenge/` должен быть доступен из интернета на стандартном порту 80.
2. Запустите `docker compose -f compose.yaml -f compose.miniapp.yaml -f compose.public.yaml up -d --build db bot miniapp nginx`. До получения сертификата Nginx отдаёт на обычные запросы HTTP 503; путь проверки домена уже работает.
3. После обновления DNS из папки `C:\PROJECTS\PolyRental` выполните `powershell -ExecutionPolicy Bypass -File .\scripts\enable-https.ps1 -Email you@example.com`, подставив свой адрес для уведомлений Let's Encrypt. Из любой другой папки укажите полный путь `C:\PROJECTS\PolyRental\scripts\enable-https.ps1`. Скрипт получает сертификат, проверяет конфигурацию Nginx, включает HTTPS, записывает `PUBLIC_URL=https://polyrental.cloudopragopa.online` в `.env` и пересоздаёт бота и Mini App.
4. Проверьте `https://polyrental.cloudopragopa.online/health` и `https://polyrental.cloudopragopa.online/miniapp`. В @BotFather задайте URL Mini App `https://polyrental.cloudopragopa.online/miniapp`.

Сертификат необходимо продлевать. Запускайте `powershell -ExecutionPolicy Bypass -File .\scripts\renew-certificate.ps1` по расписанию, например раз в месяц; команда проверяет срок сертификата и перезагружает Nginx.

Шаблоны `templates/contract.docx`, `templates/issue.docx`, `templates/return.docx` создаются при первом старте. Переменные: `booking_id`, `customer_name`, `customer_contact`, `starts_at`, `ends_at`, `equipment`, `identity`, `total`. DOCX генерируется только в памяти и отдаётся роли `PII_ADMIN_IDS` с `Cache-Control: no-store`.

Миграции: `alembic upgrade head`. При первом запуске также выполняется совместимый backfill: старые экземпляры группируются только при полном совпадении названия, ставки, описания и изображения; старые брони получают строки и уже назначенные экземпляры.

Сбор документов не включится, пока не заданы `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_CONTACT`, `PRIVACY_POLICY_VERSION`, `PII_ADMIN_IDS` и `PII_MASTER_KEY`. База и резервные копии с ПД должны физически размещаться в РФ; техническая реализация не заменяет юридическое утверждение политики и согласия.

Зашифрованная резервная копия без промежуточного plaintext-файла: задайте отдельный `BACKUP_MASTER_KEY` и выполните `python scripts/backup_encrypted.py D:\PolyRentalBackups`. Скрипт шифрует поток `pg_dump` через AES-256-GCM и удаляет зашифрованные копии старше 30 дней. Ключ храните отдельно от копий и рабочей базы.

Тесты: `docker compose --profile test run --rm --build test`. Compose создаёт для них отдельную БД `polyrental_test`.

Адаптированная [стратегия тестирования Mini App](docs/testing-strategy.md): локальный preview, API и роли, эмуляция Telegram, реальные клиенты и проверка удобства пользователями.

Практическая [отладка Telegram Mini App](docs/telegram-debug-report.md) и [запуск локальных инструментов](tools/telegram-qa/README.md): Vite-панель, проверка подписей, tg-mini-app-emulator и DevKit. Для отдельного тестового сервера Telegram предусмотрен `TELEGRAM_TEST_ENVIRONMENT=1`; в обычном окружении оставляйте `0`.
