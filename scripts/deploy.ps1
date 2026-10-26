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

$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
& docker @compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Unable to start PostgreSQL' }
& docker @compose run --rm miniapp alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw 'Database migrations did not apply' }
& docker @compose up -d --build bot miniapp nginx
if ($LASTEXITCODE -ne 0) { throw 'Unable to start production services' }

for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 5
        if ($health.status -eq 'ok') {
            Write-Output "Deployment complete: version $($health.version)"
            exit 0
        }
    } catch {
        if ($attempt -eq 12) { throw 'Mini App did not pass the /health check after deployment' }
        Start-Sleep -Seconds 5
    }
}
