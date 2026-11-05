param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCommit,
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env')) { throw '.env is missing; deployment will not overwrite production settings' }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Production checkout has uncommitted changes; deployment stopped to preserve them.' }
& git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch origin/main' }
$remoteCommit = (& git rev-parse origin/main).Trim()
if ($remoteCommit -ne $ExpectedCommit) {
    throw "origin/main ($remoteCommit) does not match the CI-verified commit $ExpectedCommit"
}
& git checkout main
if ($LASTEXITCODE -ne 0) { throw 'Unable to switch the production checkout to main' }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to update the production checkout from origin/main' }
$headCommit = (& git rev-parse HEAD).Trim()
if ($headCommit -ne $ExpectedCommit) { throw 'Production checkout does not contain the expected commit after update' }

# HTTPS is served by Windows Nginx; update only the application services.
$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml')
& docker @compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Unable to start PostgreSQL' }
& docker @compose up -d redis
if ($LASTEXITCODE -ne 0) { Write-Warning 'Redis unavailable; application will use PostgreSQL directly.' }
& docker @compose build bot miniapp
if ($LASTEXITCODE -ne 0) { throw 'Unable to build the release images' }
& docker @compose run --rm miniapp alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw 'Database migrations did not apply' }
& docker @compose up -d bot miniapp
if ($LASTEXITCODE -ne 0) { throw 'Unable to start production services' }

for ($attempt = 1; $attempt -le 12; $attempt++) {
    & docker @compose exec -T miniapp python -c "from urllib.request import urlopen; import json; health=json.load(urlopen('http://127.0.0.1:8000/health', timeout=5)); assert health['status'] == 'ok'; print('Deployment complete: version ' + health['version'])"
    if ($LASTEXITCODE -eq 0) { exit 0 }
    if ($attempt -lt 12) { Start-Sleep -Seconds 5 }
}
& docker @compose logs --tail 100 miniapp
throw 'Mini App did not pass the /health check after deployment'
