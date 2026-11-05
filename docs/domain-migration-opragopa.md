# Переезд на polyrental.opragopa.com

05.11.2026: новый HTTPS-хост включён, production бот и Mini App переключены.

Текущий выпуск — 0.5.3; значения `/health` ниже фиксируют момент самого переезда. После актуализации конфигурации `compose.miniapp.yaml` читает `PUBLIC_URL` из `.env`, не подменяет его фиксированным доменом. `scripts/deploy.ps1` обновляет приложение без запуска контейнерного Nginx. [Актуальные настройки](configuration.md), [состояние выпуска](current-state.md).

## Результат

- Google DNS и Cloudflare подтверждают A-запись `146.120.70.68`. AAAA-записи нет.
- Сертификат Let's Encrypt выпущен через win-acme, HTTP-01 успешно подтверждён.
- Windows Nginx использует отдельный `conf/conf.d/polyrental-opragopa.conf`.
  Проверка `nginx -t` и перечитывание прошли. Существующее предупреждение
  о дублирующемся имени foodmenu не относится к новому хосту.
- Новый `/health` отвечает `status=ok`, `version=0.5.2-hotfix-1`;
  `/miniapp` — HTTP 200, `/site` — HTTP 303 на вход.
- Проверка HTTPS выполнена с проверкой сертификата и явным адресом сервера
  через curl `--resolve`: локальный VPN Karing ещё кеширует служебный адрес
  и обычный запрос из текущей Windows-сессии может завершаться ошибкой TLS.
  Подмена локального DNS не отражает публичную A-запись.
- Только `bot` и `miniapp` пересозданы. Оба используют прежний образ
  `polyrental-release:0.5.2-hotfix-1-a8059d4dc91c`. Перед переключением сверено
  окружение: отличается только `PUBLIC_URL`. БД и Redis не пересоздавались.
- Новый адрес задан в `.env` и `compose.miniapp.yaml` для последующих запусков.
- Telegram Bot API подтвердил кнопку меню «Забронировать» с адресом
  `https://polyrental.opragopa.com/miniapp` (чтение методом POST без кеша).
- Страница входа содержит callback `https://polyrental.opragopa.com/site/auth`.
  Авторизация реальным пользователем в Telegram не проверялась.
- Старый HTTPS-хост сохранён и отвечает на `/health`. Перенаправление
  не включалось, чтобы сохранить ранее отправленные ссылки и календари.

## Настройки BotFather

Пользователю нужно проверить отдельно: Main Mini App URL —
`https://polyrental.opragopa.com/miniapp`, домен входа на сайт —
`polyrental.opragopa.com`. Настройки BotFather через Bot API не менялись.

## Сертификат

Файлы: `C:/certs/polyrental-opragopa/polyrental.opragopa.com-chain.pem` и
`polyrental.opragopa.com-key.pem`. win-acme сохранил renewal; следующий
плановый срок — 30.12.2026. Hook продления:
`scripts/reload-windows-nginx.ps1`. Установленный nginx.exe требует
прав администратора, поэтому `scripts/enable-opragopa-https.ps1` также
запускается с повышением. Журнал: `tmp/domain-opragopa/https-setup.log`.

## Откат

Локальный каталог `tmp/domain-opragopa/` исключён из Git. В нём сохранены
`production.env.before`, `compose.rollback.json` (точное прежнее окружение
и образы) и `compose.release.json` (использованные образы). Резервные копии
окружения содержат секреты, их нельзя публиковать.

Из корня проекта восстановить `.env` из `production.env.before`, затем:

```powershell
docker compose -p polyrental -f compose.yaml -f compose.miniapp.yaml -f compose.public.yaml -f tmp/domain-opragopa/compose.rollback.json up -d --no-deps --no-build --pull never bot miniapp
```

Проверить старый `/health` и кнопку меню Telegram. Для последующих деплоев
при откате также вернуть старый PUBLIC_URL в `compose.miniapp.yaml`.
Откат схемы БД не нужен; новый HTTPS-хост можно сохранить.
