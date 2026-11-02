$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nginx = 'C:\nginx-1.31.8\nginx.exe'
$destination = 'C:\nginx-1.31.8\conf\conf.d\polyrental-acceptance.conf'
$certificateDir = 'C:\certs\polyrental-acceptance'
$chain = Join-Path $certificateDir 'testing.cloudopragopa.online-chain.pem'
$key = Join-Path $certificateDir 'testing.cloudopragopa.online-key.pem'
if (-not (Test-Path -LiteralPath $destination)) { throw 'Enable the test HTTP host first.' }
if (-not (Test-Path -LiteralPath $chain) -or -not (Test-Path -LiteralPath $key)) {
    New-Item -ItemType Directory -Force -Path $certificateDir | Out-Null
    & 'C:\win-acme\wacs.exe' --source manual --host testing.cloudopragopa.online --validation filesystem --webroot 'C:\nginx-1.31.8\html' --store pemfiles --pemfilespath $certificateDir --installation none
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $chain) -or -not (Test-Path -LiteralPath $key)) { throw 'Certificate issuance failed; the existing HTTP configuration remains active.' }
}
$original = [IO.File]::ReadAllBytes($destination)
try {
    Copy-Item -LiteralPath (Join-Path $root 'nginx\acceptance-https.conf') -Destination $destination -Force
    & $nginx -p 'C:/nginx-1.31.8/' -t
    if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed.' }
    & $nginx -p 'C:/nginx-1.31.8/' -s reload
    if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
} catch {
    [IO.File]::WriteAllBytes($destination, $original)
    throw
}
Write-Output 'Test HTTPS host enabled.'
