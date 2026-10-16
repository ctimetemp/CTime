# Creates an admin account for the CTTIme collector dashboard.
#
# Usage:
#   .\create-admin.ps1 -Account yourname
#   .\create-admin.ps1 -Account yourname -Password "YourPass123!"
#   .\create-admin.ps1 -Account yourname -DataDir "D:\CTime\server\data"
#
# Run this from the folder that contains make-account.js (e.g. D:\CTime\scripts\).
# Or pass -DataDir to point at a different collector data folder.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Account,
    [string] $Password,
    [string] $DataDir,
    [switch] $PasswordStdin
)

$ErrorActionPreference = 'Stop'

# Find make-account.js next to this script
$here = Get-Location
$makeAccount = Join-Path $here 'make-account.js'
if (-not (Test-Path -LiteralPath $makeAccount)) {
    Write-Host "! make-account.js not found at $makeAccount" -ForegroundColor Red
    Write-Host "  Run this script from the scripts/ folder, or copy make-account.js here." -ForegroundColor Yellow
    exit 1
}

# Default data dir: project root + server/data
# If running from D:\CTime\scripts\, project root is D:\CTime
$projectRoot = Split-Path -Parent $here
if (-not $DataDir) {
    $DataDir = Join-Path $projectRoot 'server\data'
}
$dbPath = Join-Path $DataDir 'collector.db'

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host "! node.exe is not on PATH. Install Node.js 22.5+ and try again." -ForegroundColor Red
    exit 1
}

$args = @($Account)
if ($Password) { $args += '--password-stdin' }
elseif ($PasswordStdin) { $args += '--password-stdin' }
if ($DataDir) { $args += @('--db', $dbPath) }

Write-Host "Creating admin account: $Account" -ForegroundColor Cyan
Write-Host "  database: $dbPath"

if ($Password) {
    $Password | node $makeAccount @args
}
else {
    node $makeAccount @args
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done. Sign in at: https://<collector-address>:8443/login" -ForegroundColor Green
    Write-Host "  account: $Account"
} else {
    Write-Host "! Account creation failed (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}
