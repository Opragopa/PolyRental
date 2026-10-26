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

if (-not $env:CATALOG_IMPORT_CSV_B64) { throw 'CATALOG_IMPORT_CSV_B64 is not configured; import stopped.' }
if (-not (Test-Path -LiteralPath '.env')) { throw '.env is missing; import stopped.' }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Production checkout has uncommitted changes; import stopped to preserve them.' }
& git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch origin/main' }
if ((& git rev-parse origin/main).Trim() -ne $ExpectedCommit) { throw 'origin/main does not match the approved import commit.' }
& git checkout main
if ($LASTEXITCODE -ne 0) { throw 'Unable to switch production checkout to main' }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to update production checkout' }
if ((& git rev-parse HEAD).Trim() -ne $ExpectedCommit) { throw 'Production checkout does not contain the approved import commit.' }

$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
& docker @compose up -d db miniapp
if ($LASTEXITCODE -ne 0) { throw 'Unable to start production services for catalog import.' }
$before = (& docker @compose exec -T db psql -U polyrental -d polyrental -At -c "SELECT (SELECT count(*) FROM articles) || '|' || (SELECT count(*) FROM equipment);").Trim()
if ($before -ne '0|0') { throw "Production catalog is not empty ($before); import stopped." }

$python = 'import base64,json,sys; from app.catalog_import import import_catalog_csv; data=base64.b64decode(sys.stdin.buffer.read().strip(), validate=True); print(json.dumps(import_catalog_csv(data), ensure_ascii=False))'
$result = ($env:CATALOG_IMPORT_CSV_B64.Trim() | & docker @compose exec -T miniapp python -c $python).Trim()
if ($LASTEXITCODE -ne 0 -or -not $result) { throw 'Catalog CSV import failed; transaction was rolled back.' }
$after = (& docker @compose exec -T db psql -U polyrental -d polyrental -At -c "SELECT (SELECT count(*) FROM articles) || '|' || (SELECT count(*) FROM equipment) || '|' || (SELECT count(*) FROM equipment WHERE serial_number IS NULL);").Trim()
Write-Output "Production catalog import complete: $result; articles|equipment|empty_serials=$after"
