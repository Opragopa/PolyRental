# Production 0.5.8 — 10.11.2026

- После приёмки на отдельном тестовом боте пользователем переключены только bot и Mini App на `polyrental-release:0.5.8-5453f93`, собранный из коммита `5453f93f20fe316620a52f6ed0c0845579f30684`. Его дерево совпадает с объединённым `main` `4cb16b51e08eab3ea76b11c630e4cda028ac9be3`.
- [CI main 42792821560](https://github.com/Opragopa/PolyRental/actions/runs/42792821560): Test, Chromium, WebKit, документы — success; Deploy production — skipped. Переключение выполнено вручную.
- Перед миграцией создана зашифрованная копия `artifacts/backups/release-058/` и восстановлена во временную отдельную тестовую БД; исходная ревизия `20261105_43`. Также на синтетических данных проверено восстановление фотографии категории.
- Применена миграция `20261110_44`. PostgreSQL, Redis и Nginx не пересоздавались. Локальный и публичный `/health`: `ok`, `0.5.8`; bot и Mini App работают с `RestartCount=0`.
- Публичные статические файлы и серверные файлы сверены с релизным снимком. Preview smoke на 390 и 1440 px прошёл без запросов к рабочему API.
- Автоматическая публикация объявления 0.5.8 отключена; сообщение в канал не отправлялось.

## Откат приложения

```powershell
docker compose -p polyrental -f compose.yaml -f compose.miniapp.yaml -f tmp/release-058-5453f93/compose.rollback.json up -d --no-deps --no-build --pull never bot miniapp
```

Предыдущий образ: `polyrental-release:0.5.7-daebd50782bb`. Миграция добавляет необязательное поле; при откате приложения данные базы сохраняются.
