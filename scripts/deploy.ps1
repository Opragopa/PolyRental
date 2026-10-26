param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env')) { throw '.env не найден: деплой не будет перезаписывать настройки production' }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'На сервере есть незакоммиченные изменения. Деплой остановлен, чтобы не потерять их.' }
& git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Не удалось получить origin/main' }
$remoteCommit = (& git rev-parse origin/main).Trim()
if ($remoteCommit -ne $ExpectedCommit) {
    throw "origin/main ($remoteCommit) не совпадает с проверенным CI коммитом $ExpectedCommit"
}
& git checkout main
if ($LASTEXITCODE -ne 0) { throw 'Не удалось переключить production-клон на main' }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить рабочую копию из origin/main' }
$headCommit = (& git rev-parse HEAD).Trim()
if ($headCommit -ne $ExpectedCommit) { throw 'После обновления рабочая копия содержит не тот коммит' }

$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
& docker @compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить PostgreSQL' }
& docker @compose run --rm miniapp alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw 'Миграции базы данных не применились' }
& docker @compose up -d --build bot miniapp nginx
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить production-сервисы' }

for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 5
        if ($health.status -eq 'ok') {
            Write-Output "Деплой завершён: версия $($health.version)"
            exit 0
        }
    } catch {
        if ($attempt -eq 12) { throw 'Mini App не прошёл проверку /health после деплоя' }
        Start-Sleep -Seconds 5
    }
}
