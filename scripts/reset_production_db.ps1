param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCommit,
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [Parameter(Mandatory = $true)]
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$backupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
Set-Location -LiteralPath $projectRoot

if (-not $env:BACKUP_MASTER_KEY) { throw 'BACKUP_MASTER_KEY is not configured; production reset stopped.' }
if (-not (Test-Path -LiteralPath '.env')) { throw '.env is missing; production reset stopped.' }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Production checkout has uncommitted changes; reset stopped to preserve them.' }
& git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch origin/main' }
if ((& git rev-parse origin/main).Trim() -ne $ExpectedCommit) { throw 'origin/main does not match the approved reset commit.' }
& git checkout main
if ($LASTEXITCODE -ne 0) { throw 'Unable to switch production checkout to main' }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Unable to update production checkout' }
if ((& git rev-parse HEAD).Trim() -ne $ExpectedCommit) { throw 'Production checkout does not contain the approved reset commit.' }

$compose = @('compose', '-f', 'compose.yaml', '-f', 'compose.miniapp.yaml', '-f', 'compose.public.yaml')
& docker @compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Unable to start PostgreSQL for backup' }
$backupMount = "$backupDirectory`:/backup"
$backupCommand = "docker $($compose -join ' ') exec -T db pg_dump -U polyrental -d polyrental --format=custom | docker run --rm -i --env BACKUP_MASTER_KEY -v `"$backupMount`" polyrental-miniapp:latest python /app/scripts/backup_encrypted.py /backup --stdin"
& cmd.exe /d /s /c $backupCommand
if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup failed; reset stopped.' }
$backup = Get-ChildItem -LiteralPath $backupDirectory -Filter 'polyrental-*.prbak' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $backup -or $backup.Length -le 0) { throw 'Encrypted backup file is missing or empty; reset stopped.' }
$verifyName = "polyrental-backup-verify-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
try {
    & docker run -d --rm --name $verifyName -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify postgres:16
    if ($LASTEXITCODE -ne 0) { throw 'Unable to start isolated PostgreSQL backup verifier.' }
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        & docker exec $verifyName pg_isready -U postgres -d verify | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        if ($attempt -eq 20) { throw 'Isolated backup verifier did not become ready.' }
        Start-Sleep -Seconds 1
    }
    $verifyCommand = "docker run --rm -i --env BACKUP_MASTER_KEY -v `"$backupMount`" polyrental-miniapp:latest python /app/scripts/verify_encrypted_backup.py /backup/$($backup.Name) --stdout | docker run --rm -i --network container:$verifyName -e PGPASSWORD=verify postgres:16 pg_restore -h 127.0.0.1 -U postgres -d verify --exit-on-error -"
    & cmd.exe /d /s /c $verifyCommand
    if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup restore verification failed; reset stopped.' }
} finally {
    & docker rm -f $verifyName 2>$null | Out-Null
}

$dbContainer = (& docker @compose ps -q db).Trim()
if (-not $dbContainer) { throw 'Unable to resolve the production PostgreSQL container.' }
$dbVolume = (& docker inspect $dbContainer --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}').Trim()
if (-not $dbVolume) { throw 'Unable to resolve the PostgreSQL data volume; reset stopped.' }
Write-Output "Removing only PostgreSQL volume: $dbVolume"
& docker @compose down
if ($LASTEXITCODE -ne 0) { throw 'Unable to stop production services.' }
& docker volume rm $dbVolume
if ($LASTEXITCODE -ne 0) { throw 'Unable to remove the PostgreSQL data volume.' }

& docker @compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Unable to create fresh PostgreSQL.' }
& docker @compose run --rm miniapp alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw 'Database migrations failed on the fresh PostgreSQL.' }
& docker @compose up -d --build bot miniapp nginx
if ($LASTEXITCODE -ne 0) { throw 'Unable to restart production services.' }
for ($attempt = 1; $attempt -le 12; $attempt++) {
    & docker @compose exec -T miniapp python -c "from urllib.request import urlopen; import json; health=json.load(urlopen('http://127.0.0.1:8000/health', timeout=5)); assert health['status'] == 'ok'; print('Fresh deployment: version ' + health['version'])"
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 12) { throw 'Mini App did not pass the /health check after reset.' }
    Start-Sleep -Seconds 5
}
$counts = (& docker @compose exec -T db psql -U polyrental -d polyrental -At -c "SELECT (SELECT count(*) FROM bookings), (SELECT count(*) FROM articles), (SELECT last_value::text || ':' || is_called::text FROM bookings_id_seq);").Trim()
if ($counts -ne '0|0|1:false') { throw "Fresh database validation failed: $counts" }
Write-Output "Production database reset complete. Verified backup: $($backup.FullName)"
