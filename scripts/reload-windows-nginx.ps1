# win-acme installation hook: validate before reloading renewed certificates.
$ErrorActionPreference = 'Stop'
$nginx = 'C:\nginx-1.31.8\nginx.exe'
& $nginx -p 'C:/nginx-1.31.8/' -t
if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed; reload skipped.' }
& $nginx -p 'C:/nginx-1.31.8/' -s reload
if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
