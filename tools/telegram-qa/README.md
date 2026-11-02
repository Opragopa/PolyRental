# Локальная отладка Telegram Mini App

Изолированный dev-проект с настоящими `vite-plugin-telegram-mini-app`, `telegram-mock-init-data`, `tg-mini-app-emulator` и `tma-devkit`. Интерфейс берётся из `app/miniapp_static`; рабочий сервер и бот не изменяются при запуске этих инструментов. Фактические результаты: [отчёт](../../docs/telegram-debug-report.md).

## Подготовка

Нужны Docker, Node.js 24, pnpm и Bun (проверен Bun 1.4.4). Установить JS-зависимости из этой папки:

```powershell
pnpm install --frozen-lockfile
```

Запустить из корня репозитория QA API с отдельной БД и фиктивным токеном:

```powershell
docker compose --profile test run --rm --build -p 127.0.0.1:8001:8000 -v "${PWD}:/app" test python scripts/qa_server.py
```

Не запускать pytest одновременно с браузерным QA: тесты очищают `polyrental_test`. Стандартный токен всех этих mock-сред — `123:local-qa-only`; он не подходит для настоящего Telegram. QA API не отправляет уведомления. Рабочий `BOT_TOKEN` в инструменты подставлять не нужно.

Порты 15173–15175 выбраны потому, что в проверенной Windows-среде привязка к 5173–5175 возвращала `EACCES`.

## Vite-панель

В этой папке:

```powershell
pnpm run dev
```

Открыть `http://localhost:15173/miniapp`, нажать кнопку `tma` и выбрать Alice (42), Bob (43), склад (100), проверяющего документы (200) или гостя. Identity меняет подпись и перезагружает страницу; тему можно менять без перезагрузки.

`http://localhost:15173/miniapp?legacyCrypto=1` — QA-сценарий, отключающий `crypto.randomUUID` до запуска приложения. Он нужен для проверки резервного UUID, используемого при HTTP в тестовом Telegram. В рабочий HTML этот скрипт не попадает.

## Подпись из telegram-mock-init-data

При работающем QA API:

```powershell
pnpm run check:init-data
```

Проверяются настоящий ответ `/api/miniapp/me`, просроченная, но правильно подписанная дата, подмена пользователя, другой бот и пустая авторизация. Результат сохраняется в `artifacts/init-data-results.json`.

## tg-mini-app-emulator

В отдельном терминале из этой папки запустить вход с SDK эмулятора:

```powershell
$env:QA_TOOL = 'emulator'
pnpm exec vite
```

В другом терминале:

```powershell
pnpm run emulator
```

Открыть `http://localhost:1234`. `run-emulator.mjs` запускает оригинальный CLI через Bun: опубликованная версия 0.1.1 использует `Bun.serve` и падает при запуске через Node. Скрипт использует Bun из PATH, `BUN_EXECUTABLE` или уже скачанный `vendor/package/bin/bun.exe`.

Проверка обоих профилей на сервере:

```powershell
pnpm run check:emulator
```

Результат — `artifacts/emulator-results.json`. `channel_inline` передаёт `start_param=channel_id=QA_CHANNEL`; `attachment_menu_channel` передаёт `chat`. Приложение пока не выполняет специальную маршрутизацию по этим полям.

Ограничения опубликованного SDK: нет методов индикатора MainButton; переключатель Dark Mode меняет рамку и состояние SDK, но не синхронизирует CSS-переменные официального Telegram SDK. Тему приложения проверять также в Vite и DevKit. Конфигурационный `theme` не заменяет переключение Dark Mode в интерфейсе эмулятора.

## TMA DevKit

В отдельном терминале:

```powershell
$env:QA_TOOL = 'devkit'
pnpm exec vite
```

В другом терминале:

```powershell
pnpm run devkit
```

В панели `http://localhost:15188` указать App URL `http://localhost:15174/miniapp`, Bot token `123:local-qa-only` и ID 42. Нажать Apply & reload. Пресеты Premium User · iOS и Free User · Android переключают платформу и тему; роли приложения определяются ID, а не Premium.

Локальный `devkit-sdk.mjs` исправляет дефект именно версии 0.1.1: её исходный код добавляет placeholder `signature` после расчёта HMAC. Адаптер пересчитывает hash со всеми полями, кроме hash, как это делает aiogram и сервер PolyRental. Рабочая проверка подписи не меняется. При обновлении пакета адаптер требует пересмотра и не применяет замену молча к неизвестному коду.

При прямом открытии launch URL вне панели после смены только URL-fragment нужна полная перезагрузка: SDK читает конфигурацию во время запуска.

## TMA-Studio и настоящий Telegram

TMA-Studio 1.3.4 установлен в `vendor/studio` из [официального выпуска](https://github.com/erfanmola/TMA-Studio/releases/tag/v1.3.4). В текущем проходе Studio удалось запустить, но управление окном заблокировалось на уровне средства Windows. Пройденными считаются только проверки, перечисленные в отчёте; стартовый экран Studio не подтверждает работу приложения внутри него.

### Визуальный QA и чек-лист Studio

Для воспроизводимой проверки интерфейса установите `NODE_PATH` на `tools/browser-qa/node_modules` и выполните `pnpm run qa:visual`. Скриншоты сохраняются только при заданном `QA_SCREENSHOTS`, например `QA_SCREENSHOTS=artifacts/visual-qa pnpm run qa:visual`; папка `artifacts` не попадает в Git.

После успешного скрипта откройте в Studio `http://127.0.0.1:15173/miniapp` и на каждом из **Telegram iOS**, **Telegram Android** и **Telegram Desktop**:

1. Выберите допустимые начало и конец периода.
2. Убедитесь, что активная кнопка шага находится над нижней навигацией, а навигация остаётся внизу.
3. Откройте «Бронирование» и «Профиль», проверьте SVG-иконки в светлой и тёмной теме.
4. Проверьте DevTools Studio: ошибок страницы и консоли быть не должно.

Настоящий Telegram отложен по решению пользователя. Для будущей проверки на отдельном тестовом сервере в проект добавлен `TELEGRAM_TEST_ENVIRONMENT=1`: фабрика бота и уведомления используют тестовые API/file URL, а HTTP Mini App разрешён только с этим флагом. По умолчанию флаг выключен. Нужны отдельные тестовый аккаунт, бот и QA-развёртывание; обычный `compose.miniapp.yaml` публикует порт только на loopback и не открывает его телефону по LAN.

## Результаты и очистка

`artifacts`, `vendor` и `node_modules` не включаются в Git; vendor и node_modules также исключены из Docker-контекста. Скриншоты и итоговый отчёт находятся в `docs/qa` и `docs/telegram-debug-report.md`. Останавливать локальные dev-серверы можно Ctrl+C в их терминалах. Не использовать `docker compose down --volumes`: это затронет БД проекта.
