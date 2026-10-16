# Creates an admin account for the CTTIme collector dashboard.
#
# Usage:
#   .\create-admin.ps1 -Account yourname
#   .\create-admin.ps1 -Account yourname -Password "YourPass123!"
#   .\create-admin.ps1 -Account yourname -DataDir "D:\CTime\server\data"
#
# There is no default account. Run this once on the collector machine before
# any device can enroll or any admin can sign in.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Account,
    [string] $Password,
    [string] $DataDir,
    [switch] $PasswordStdin
)

$ErrorActionPreference = 'Stop'

# Default data dir relative to this script's location
if (-not $DataDir) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
    $DataDir = Join-Path $scriptDir 'server\data'
}

$root = Resolve-Path $scriptDir
$makeAccount = Join-Path $root 'scripts\make-account.js'
$dbPath   = Join-Path $DataDir 'collector.db'

if (-not (Test-Path -LiteralPath $makeAccount)) {
    Write-Host "! make-account.js not found at $makeAccount" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host "! node.exe is not on PATH. Install Node.js 22.5+ and try again." -ForegroundColor Red
    exit 1
}

$args = @($Account)
if ($PasswordStdin) { $args += '--password-stdin' }
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
