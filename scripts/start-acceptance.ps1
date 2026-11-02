$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Read-EnvFile([string]$path) {
    $values = @{}
    if (Test-Path -LiteralPath $path) {
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
                $values[$Matches[1]] = $Matches[2].Trim('"', "'")
            }
        }
    }
    return $values
}

if (-not (Test-Path -LiteralPath '.env.acceptance')) { throw 'Создайте .env.acceptance по примеру .env.acceptance.example.' }
if (-not (Test-Path -LiteralPath '.env')) { throw 'Невозможно проверить изоляцию от production: локальный .env не найден.' }
$qa = Read-EnvFile '.env.acceptance'
$production = Read-EnvFile '.env'
if (-not $production['BOT_TOKEN'] -or -not $production['BOT_USERNAME']) { throw 'Невозможно проверить изоляцию от production: в .env не задан бот.' }
foreach ($key in @('BOT_TOKEN', 'BOT_USERNAME', 'ADMIN_IDS', 'PII_ADMIN_IDS', 'PUBLIC_URL', 'SESSION_SECRET', 'PII_MASTER_KEY', 'ICAL_TOKEN')) {
    if (-not $qa[$key]) { throw "Заполните $key в .env.acceptance." }
}
if ($production['BOT_TOKEN'] -and $qa['BOT_TOKEN'] -eq $production['BOT_TOKEN']) { throw 'Для приёмки нужен отдельный Telegram-бот.' }
if ($production['BOT_USERNAME'] -and $qa['BOT_USERNAME'].TrimStart('@') -eq $production['BOT_USERNAME'].TrimStart('@')) { throw 'Для приёмки нужен отдельный Telegram-бот.' }
$testUrl = $null
if (-not [Uri]::TryCreate($qa['PUBLIC_URL'], [UriKind]::Absolute, [ref]$testUrl) -or $testUrl.Scheme -ne 'https' -or $testUrl.Host -eq 'replace-with-separate-test-domain.example' -or $testUrl.AbsolutePath -ne '/' -or $testUrl.Query -or $testUrl.Fragment) { throw 'PUBLIC_URL должен быть отдельным HTTPS-адресом без пути.' }
$prodUrl = $null
if ($testUrl.Host -eq 'polyrental.cloudopragopa.online' -or ($production['PUBLIC_URL'] -and [Uri]::TryCreate($production['PUBLIC_URL'], [UriKind]::Absolute, [ref]$prodUrl) -and $prodUrl.Host -eq $testUrl.Host)) { throw 'Для приёмки нужен отдельный домен.' }
if ($qa['SESSION_SECRET'].Length -lt 32 -or $qa['ICAL_TOKEN'].Length -lt 32) { throw 'SESSION_SECRET и ICAL_TOKEN должны содержать не менее 32 символов.' }
if ($qa['SESSION_SECRET'] -eq $qa['ICAL_TOKEN']) { throw 'Для SESSION_SECRET и ICAL_TOKEN нужны разные значения.' }
foreach ($key in @('SESSION_SECRET', 'PII_MASTER_KEY', 'ICAL_TOKEN')) {
    if ($production[$key] -and $qa[$key] -eq $production[$key]) { throw "Для $key нужен отдельный тестовый ключ." }
}
& docker compose -p polyrental-acceptance -f compose.acceptance.yaml up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить тестовое окружение.' }
Write-Output 'Тестовая Mini App слушает 127.0.0.1:18080. Настройте HTTPS-прокси отдельного тестового домена к этому адресу.'
