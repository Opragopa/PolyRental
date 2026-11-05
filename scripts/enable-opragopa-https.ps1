# Run from an elevated Windows PowerShell. Changes only the new Nginx host.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'tmp/domain-opragopa'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir 'https-setup.log') -Append
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script as Administrator: nginx.exe requires elevation.'
    }
    $nginx = 'C:\nginx-1.31.8\nginx.exe'
    $destination = 'C:\nginx-1.31.8\conf\conf.d\polyrental-opragopa.conf'
    $certDir = 'C:\certs\polyrental-opragopa'
    $chain = Join-Path $certDir 'polyrental.opragopa.com-chain.pem'
    $key = Join-Path $certDir 'polyrental.opragopa.com-key.pem'

    function Install-Host([string]$source) {
        $previous = $null
        if (Test-Path -LiteralPath $destination) { $previous = [IO.File]::ReadAllBytes($destination) }
        try {
            Copy-Item -LiteralPath $source -Destination $destination -Force
            & $nginx -p 'C:/nginx-1.31.8/' -t
            if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed.' }
            & $nginx -p 'C:/nginx-1.31.8/' -s reload
            if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
        } catch {
            if ($null -ne $previous) { [IO.File]::WriteAllBytes($destination, $previous) }
            else { Remove-Item -LiteralPath $destination -ErrorAction SilentlyContinue }
            throw
        }
    }

    if (-not (Test-Path -LiteralPath $chain) -or -not (Test-Path -LiteralPath $key)) {
        if (Test-Path -LiteralPath $destination) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path $logDir 'nginx-before.conf') -Force
        }
        Install-Host (Join-Path $root 'nginx/production-opragopa-http.conf')
        New-Item -ItemType Directory -Force -Path $certDir | Out-Null
        # The existing win-acme renewal task processes all saved renewals.
        & 'C:\win-acme\wacs.exe' --source manual --host polyrental.opragopa.com --validation filesystem --webroot 'C:\nginx-1.31.8\html' --store pemfiles --pemfilespath $certDir --installation script --script (Join-Path $root 'scripts/reload-windows-nginx.ps1') --accepttos --notaskscheduler
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $chain) -or -not (Test-Path -LiteralPath $key)) {
            throw 'Certificate issuance failed; the old production host remains unchanged.'
        }
    }
    Install-Host (Join-Path $root 'nginx/production-windows-opragopa.conf')
    Write-Output 'HTTPS enabled for polyrental.opragopa.com. Application PUBLIC_URL has not been changed by this script.'
    Get-ScheduledTask | Where-Object { $_.TaskName -match 'win-acme' } | Select-Object TaskName,State
} finally {
    Stop-Transcript
}
