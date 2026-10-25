param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
    [string]$Email
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot

$domain = 'polyrental.cloudopragopa.online'
$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
$activePath = Join-Path $projectRoot 'nginx\active.conf'
$httpsPath = Join-Path $projectRoot 'nginx\miniapp-https.conf'
$envPath = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $envPath)) { throw '.env не найден' }
$resolved = Resolve-DnsName $domain -Type A -ErrorAction Stop
if (-not ($resolved | Where-Object { $_.IPAddress })) { throw "Нет A-записи для $domain" }

& docker @compose up -d db bot miniapp nginx
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить Nginx' }

& docker @compose run --rm certbot certonly --webroot -w /var/www/certbot -d $domain --email $Email --agree-tos --no-eff-email --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Certbot не смог подтвердить домен. Проверьте DNS и доступность TCP-порта 80 извне.' }

$original = [System.IO.File]::ReadAllBytes($activePath)
[System.IO.File]::WriteAllBytes($activePath, [System.IO.File]::ReadAllBytes($httpsPath))
try {
    & docker @compose exec -T nginx nginx -t
    if ($LASTEXITCODE -ne 0) { throw 'Проверка конфигурации Nginx не прошла' }
    & docker @compose exec -T nginx nginx -s reload
    if ($LASTEXITCODE -ne 0) { throw 'Nginx не смог перечитать конфигурацию' }
} catch {
    [System.IO.File]::WriteAllBytes($activePath, $original)
    & docker @compose exec -T nginx nginx -s reload | Out-Null
    throw
}

$content = [System.IO.File]::ReadAllText($envPath)
$newValue = "PUBLIC_URL=https://$domain"
if ($content -match '(?m)^PUBLIC_URL=') {
    $content = [regex]::Replace($content, '(?m)^PUBLIC_URL=.*$', $newValue)
} else {
    $content = $content.TrimEnd("`r", "`n") + "`r`n$newValue`r`n"
}
[System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))

& docker @compose up -d --no-deps --force-recreate bot miniapp
if ($LASTEXITCODE -ne 0) { throw 'HTTPS включён, но не удалось перезапустить бота и Mini App' }

Write-Output "HTTPS включён: https://$domain/miniapp"
