# CTTIme agent deployment script — installs the agent on one device, manually,
# with an invisible scheduled task, then walks through the consent/approval steps.
#
# Prerequisites:
#   - Collector is running and reachable from this device
#   - You have the collector's cert SHA-256 pin (from `node scripts\make-cert.js --check`)
#   - You are running as the device user who will be monitored
#
# Examples:
#   .\scripts\deploy.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex> -Client python -AgentExe C:\durable\CTTImeAgent.exe
#   .\scripts\deploy.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex> -Client python -Acknowledge
#
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $CollectorHost,
    [Parameter(Mandatory = $true)][string] $Pin,
    [string] $CollectorPort = '8443',
    [ValidateSet('node', 'python')][string] $Client = 'python',
    [string] $NodePath,
    [string] $PythonPath,
    [string] $AgentExe,
    [string] $SourceDir,
    [string] $StateDir = (Join-Path $env:PROGRAMDATA 'CTTIme'),
    [string] $TaskName = 'CTTIme Endpoint Visibility',
    [switch] $Acknowledge,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

if ($Pin -notmatch '^[0-9a-fA-F]{64}$') {
    Write-Host "! Pin must be the 64-character SHA-256 fingerprint from the collector." -ForegroundColor Red
    exit 1
}

# Normalize state dir
$StateDir = [IO.Path]::GetFullPath($StateDir)

Write-Host "CTTIme agent deployment" -ForegroundColor Cyan
Write-Host "  collector      $CollectorHost:$CollectorPort"
Write-Host "  certificate    pinned to $($Pin.ToLower())"
Write-Host "  client         $Client"
Write-Host "  state dir      $StateDir"
Write-Host "  task name      $TaskName"
Write-Host ""

if ($DryRun) {
    Write-Host '-DryRun: nothing was created. Planned:' -ForegroundColor Yellow
    Write-Host "  1. Install agent (invisible via --resident)"
    Write-Host "  2. Acknowledge notice (device user types their own name)"
    Write-Host "  3. Approve on dashboard (manual step)"
    exit 0
}

# --- Step 1: Install (invisible task, --resident) ---
Write-Host "Step 1: Installing agent..." -ForegroundColor Cyan
$installArgs = @(
    '-CollectorHost', $CollectorHost,
    '-CollectorPort', $CollectorPort,
    '-Pin', $Pin,
    '-Client', $Client,
    '-StateDir', $StateDir,
    '-TaskName', $TaskName
)
if ($NodePath)     { $installArgs += @('-NodePath', $NodePath) }
if ($PythonPath)   { $installArgs += @('-PythonPath', $PythonPath) }
if ($AgentExe)     { $installArgs += @('-AgentExe', $AgentExe) }
if ($SourceDir)    { $installArgs += @('-SourceDir', $SourceDir) }

& $PSScriptRoot\install.ps1 @installArgs

if ($LASTEXITCODE -ne 0) {
    Write-Host "! Install failed." -ForegroundColor Red
    exit 1
}

Write-Host "Step 1 complete: agent installed, scheduled task registered (invisible)." -ForegroundColor Green

# --- Step 2: Acknowledge ---
if ($Acknowledge) {
    Write-Host "Step 2: Showing notice to the device user..." -ForegroundColor Cyan
    $agentArgs = @('run', '--host', $CollectorHost, '--port', $CollectorPort,
                   '--pin', $Pin.ToLower(), '--state-dir', $StateDir, '--interactive')

    $execute = if ($Client -eq 'python' -and $AgentExe) { $AgentExe }
               elseif ($Client -eq 'python') { (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
               else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }

    if (-not $execute) {
        Write-Host "! No executable found for acknowledge step." -ForegroundColor Red
        exit 1
    }

    Push-Location (Split-Path -Parent $execute)
    try {
        & $execute @agentArgs
    } finally { Pop-Location }

    Write-Host "Step 2 complete: notice acknowledged by the device user." -ForegroundColor Green
}
else {
    Write-Host "Step 2 (skipped): Run this as the device user to acknowledge:" -ForegroundColor Yellow
    $cmd = if ($AgentExe) { "& `"$AgentExe`" run --host $CollectorHost --port $CollectorPort --pin $Pin --interactive --state-dir `"$StateDir`"" }
           else { "python -m CTTIme_agent run --host $CollectorHost --port $CollectorPort --pin $Pin --interactive --state-dir `"$StateDir`"" }
    Write-Host "  $cmd"
}

# --- Step 3: Approve (manual dashboard step) ---
Write-Host ""
Write-Host "Step 3 (manual): Approve the device on the dashboard." -ForegroundColor Yellow
Write-Host "  Open https://$CollectorHost:$CollectorPort"
Write-Host "  Go to Overview > Approval queue > click Approve"
Write-Host ""

# --- Step 4: Verify ---
Write-Host "Step 4: Verifying installation..." -ForegroundColor Cyan
$verifyArgs = @('status', '--state-dir', $StateDir)
if ($Client -eq 'python' -and $AgentExe) { & $AgentExe @verifyArgs }
elseif ($Client -eq 'python') { python -m CTTIme_agent @verifyArgs }
else { node "cli.js" @verifyArgs }

Write-Host ""
Write-Host "Deployment done. Next:" -ForegroundColor Green
Write-Host "  1. Approve the device on the dashboard"
Write-Host "  2. On the Policy page, set:"
Write-Host "     screenshot_interval_minutes = 1"
Write-Host "     heartbeat_interval_seconds  = 300"
Write-Host "     clipboard_sample_seconds    = 300"
Write-Host "  3. The task runs --resident (no window) at logon and every 5 minutes."
