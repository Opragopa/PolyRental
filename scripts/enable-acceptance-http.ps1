$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = 'C:\nginx-1.31.8\conf\conf.d\polyrental-acceptance.conf'
$nginx = 'C:\nginx-1.31.8\nginx.exe'
if (Test-Path -LiteralPath $destination) { throw 'Test configuration already exists; refusing to overwrite.' }
Copy-Item -LiteralPath (Join-Path $root 'nginx\acceptance-http.conf') -Destination $destination
try {
    & $nginx -p 'C:/nginx-1.31.8/' -t
    if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed.' }
    & $nginx -p 'C:/nginx-1.31.8/' -s reload
    if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
} catch {
    Remove-Item -LiteralPath $destination -ErrorAction SilentlyContinue
    throw
}
Write-Output 'Test HTTP host enabled; HTTPS certificate has not yet been installed.'
