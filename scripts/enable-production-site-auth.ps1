$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = 'C:\nginx-1.31.8\conf\conf.d\polyrental.conf'
$candidate = Join-Path $root 'nginx\production-windows-0.4.8.conf'
$nginx = 'C:\nginx-1.31.8\nginx.exe'
if (-not (Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath $candidate)) { throw 'Nginx configuration is missing.' }
$original = [IO.File]::ReadAllBytes($destination)
$backup = Join-Path $root 'tmp\production-nginx-before-0.4.8.conf'
if (Test-Path -LiteralPath $backup) { throw 'Backup already exists; review it before continuing.' }
[IO.File]::WriteAllBytes($backup, $original)
try {
    Copy-Item -LiteralPath $candidate -Destination $destination -Force
    & $nginx -p 'C:/nginx-1.31.8/' -t
    if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed.' }
    & $nginx -p 'C:/nginx-1.31.8/' -s reload
    if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
} catch {
    [IO.File]::WriteAllBytes($destination, $original)
    throw
}
Write-Output 'Production Nginx configured for Telegram login. Previous configuration saved in tmp.'
