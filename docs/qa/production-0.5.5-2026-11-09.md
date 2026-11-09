# Production 0.5.5 — 09.11.2026

- В 13:55 МСК бот и Mini App переключены на единый образ `polyrental-release:0.5.5-d07fa3e12980`, собранный из Git archive коммита `d07fa3e12980a7f676d1635eb76a0d585dbf2b71`. OCI revision указывает этот commit.
- [CI 42603991154](https://github.com/Opragopa/PolyRental/actions/runs/42603991154): Test, Chromium, WebKit, документы — success. Deploy production — skipped; выполнен ручной деплой после CI.
- Локально: **405 passed** на отдельной `polyrental_test`, все **33 браузерных набора Chromium**. На финальном образе: **17 passed** (CSV, версия, release notes/channel, авторизация сайта). Дополнительно проверены каталог и форма комплекта на 320/1440px.
- Окружение сверено с работающими контейнерами без вывода секретов. Переключены только bot/miniapp через `--no-deps --no-build --pull never`. PostgreSQL, Redis и Nginx не пересоздавались; миграции не запускались. Учебные строки CSV в production не импортировались.
- Локальный и публичный `/health`: `ok`, `0.5.5`. Публичные JS/CSS и CSV совпадают по SHA-256 с файлами точного Git archive, использованного для сборки. Начальное сравнение с Windows checkout обнаружило различие окончаний строк неизменённого dialogs.js; проверка исправлена на сравнение со сборочным снимком. Исходники импорта, авторизации сайта и объявлений внутри контейнера также сверены по хешам со снимком.
- Публичная страница входа содержит версию 0.5.5 и новую шапку. Оба контейнера работают с `RestartCount=0`.
- Публичный preview smoke прошёл на 390×844 и 1440×900: каталог → корзина → период → сводка, профиль, инструкция, изоляция фона и клавиатурный фокус. Все API-запросы заблокированы; вызовов API, создания заявок и импорта оборудования в smoke не было. Снимки: `artifacts/production-055/`.
- Объявление опубликовано штатным издателем: [пост №23](https://t.me/PolyRental_channel/23), `sent`, `attempts=1`. Отдельная ручная отправка не выполнялась.
- Реальный вход Telegram-аккаунтом и ручная приёмка физических устройств в эти проверки не входят.

## Откат

Из корня проекта:

```powershell
docker compose -p polyrental -f compose.yaml -f compose.miniapp.yaml -f tmp/release-055/compose.rollback.json up -d --no-deps --no-build --pull never bot miniapp
```

Сохранены разные прежние образы: bot `polyrental-release:0.5.4-hotfix-1-50c4cd047efe`, Mini App `polyrental-release:0.5.4-hotfix-1-header-20261109`. Не удалять данные и журнал публикаций при откате. Снимок исходников, compose-файлы, проверки и image/commit находятся в игнорируемом `tmp/release-055`.
