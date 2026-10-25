$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot

$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
& docker @compose run --rm certbot renew --webroot -w /var/www/certbot --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Продление сертификата завершилось ошибкой' }
& docker @compose exec -T nginx nginx -t
if ($LASTEXITCODE -ne 0) { throw 'Конфигурация Nginx не прошла проверку' }
& docker @compose exec -T nginx nginx -s reload
if ($LASTEXITCODE -ne 0) { throw 'Nginx не смог перечитать сертификат' }
Write-Output 'Проверка продления сертификата завершена.'
