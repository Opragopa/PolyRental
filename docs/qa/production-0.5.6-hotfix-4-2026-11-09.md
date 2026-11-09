# Production 0.5.6-hotfix-4 — 09.11.2026

- В 16:21 МСК bot и Mini App переключены на `polyrental-release:0.5.6-hotfix-4-afe24e61ed1a`, собранный из Git archive коммита `afe24e61ed1ac66d20f52f963712422bf3fd7b0c`. OCI revision соответствует коммиту.
- [CI 42623910400](https://github.com/Opragopa/PolyRental/actions/runs/42623910400): Test, Chromium, WebKit и документы — success. Deploy production — skipped; ручное переключение выполнено после CI.
- Применён одобренный пользователем вариант из artifacts/calendar-selection-preview: внутри диапазона 70% базового цвета дня и 30% цвета текста статуса; начало и конец — насыщенная заливка статуса с белыми цифрами. Зелёный/жёлтый/красный статусы сохраняются, нижняя линия внутренних дней убрана.
- Локально calendar-ui и release-052-ui прошли, включая восемь комбинаций ширины/темы 320–430px, все три статуса, белые цифры границ и снятие выделения со старого диапазона. Локальные снимки: tmp/release-056-hotfix-4/calendar-320.png и calendar-390.png.
- На финальном образе 11 release-проверок прошли на отдельной тестовой БД. Серверный код и логика бронирования не менялись. Полный серверный набор и 34 браузерных набора Chromium/WebKit проверены CI.
- Окружение сверено без вывода секретов; переключены только bot/miniapp через `--no-deps --no-build --pull never`. PostgreSQL, Redis и Nginx не пересоздавались. Миграций и новых переменных окружения нет; схема сохраняется `20261105_43`.
- Локальный и публичный /health: ok, 0.5.6-hotfix-4. Публичные JS/CSS/CSV и исходники внутри контейнера сверены по SHA-256 с точным снимком. Оба сервиса running, RestartCount=0.
- Публичный preview smoke прошёл на 390×844 (тёмная тема) и 1440×900 (светлая): каталог, предел количества, корзина, даты, тёмная заливка диапазона, белые цифры границ, сводка, профиль и инструкция, клавиатура и изоляция фона. Все API-запросы браузерного smoke заблокированы, реальных заявок и импорта не было. Снимки: artifacts/production-056-hotfix-4/calendar-390.png, calendar-1440.png и review-*.png.
- Hotfix сохраняет объявление 0.5.6; в release_publications только 0.5.6, sent, attempts=1, message_id=24. Отдельного поста нет. Физические Telegram-клиенты и реальный вход отдельно не проверялись.

## Откат

```powershell
docker compose -p polyrental -f compose.yaml -f compose.miniapp.yaml -f tmp/release-056-hotfix-4/compose.rollback.json up -d --no-deps --no-build --pull never bot miniapp
```

Прежний образ обоих сервисов: `polyrental-release:0.5.6-hotfix-3-b941b5ed5775`. Снимок исходников, compose-файлы, image/commit и проверки сохранены в tmp/release-056-hotfix-4. Данные и журнал публикаций при откате сохранять.
