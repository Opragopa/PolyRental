# Production 0.5.11 — 13.11.2026

Выпущено в 17:22 МСК по запросу пользователя на основной `@PolyRental_bot` и `https://polyrental.opragopa.com`.

## Сборка

Перенесены точные образы работающего тестового бота 0.5.11, без пересборки:

- bot: `polyrental-release:0.5.11-accepted-bot`, image ID `sha256:ea23e06fb003add5b553e7cef114527387b2dba9de47459c7cd47b85a3cab0d4`;
- miniapp: `polyrental-release:0.5.11-accepted-miniapp`, image ID `sha256:4c0bd45198053a1e57326827ebbfa2589a2f119c1000b894de00fcf49d15a49c`.

Локальный рабочий кандидат уже содержал дополнительные изменения и миграцию 47; он не выпущен. Git commit, push и GitHub Actions не выполнялись.

## Проверки и резервная копия

- Перед выпуском создана зашифрованная копия `artifacts/backups/release-0511/production-before-0511.prbak`. Проверены расшифровка, восстановление в отдельную БД и миграция принятой сборкой с `20261110_45` на `20261113_46`.
- Полный серверный прогон принятого образа в отдельном временном PostgreSQL: 473 passed, 3 failed. Одна ошибка вызвана выбранной Redis DB 14 вместо требуемой тестом DB 15; две — устаревшим ожиданием `?v=0.5.11` вместо хеша содержимого. Повторный прогон кэша, frontend assets и релизных проверок с отдельным Redis DB 15 и исправленным ожиданием URL в извлечённой временной копии теста: 9 passed. Код релизных образов не менялся.
- `release-0511-ui`, `booking-submit-ui`, `profile-onboarding-ui` прошли в Edge и WebKit. Проверка профиля Edge потребовала повторения после расхождения координат на 1–2 px во время анимации; повтор прошёл без изменений.
- Переменные окружения перед переключением совпали с действующими production-контейнерами. PostgreSQL, Redis, Nginx и тестовый бот не пересоздавались.
- Production-миграция достигла `20261113_46`. Локальный и публичный `/health`: `ok`, `0.5.11`.
- 13 публичных JS/CSS сверены побайтово с принятым образом; HTML отдаётся с `no-store`, статика — с `no-cache`.
- Оба контейнера работают, `RestartCount=0`. Telegram `getMe` подтвердил `PolyRental_bot`; меню открывает `https://polyrental.opragopa.com/miniapp?build=86d4ad57160e5396`.
- Автопубликация объявления отключена; пост в канал не отправлялся. Проверки production не создавали заявок и не отправляли тестовых сообщений клиентам. Физический Telegram после выпуска автоматически не проверялся.

Результаты проверок: `tmp/release-0511/production-result.json`, `tmp/release-0511/backup-result.json`.

## Откат приложения

Сохранены оба прежних production-образа 0.5.10. Команда отката:

```powershell
docker compose -p polyrental -f compose.yaml -f compose.miniapp.yaml -f tmp/release-0511/compose.rollback.json up -d --no-deps --no-build --pull never bot miniapp
```

Для повторного запуска выпущенных образов используйте `tmp/release-0511/compose.accepted.json`. Миграция 46 добавляет отдельную таблицу; откат приложения не требует удаления таблицы и данных.
