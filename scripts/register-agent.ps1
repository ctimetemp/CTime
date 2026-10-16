# Registers and acknowledges a CTTIme agent via PowerShell only — no manual .exe runs.
#
# After install, the agent is enrolled but not yet acknowledged. This script runs the
# acknowledgment non-interactively so the device appears in the dashboard approval queue.
#
# Usage:
#   .\scripts\register-agent.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex> -AcknowledgeBy "John Doe"
#   .\scripts\register-agent.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex> -AcknowledgeBy "John Doe" -AgentExe C:\durable\CTTImeAgent.exe
#   .\scripts\register-agent.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex> -AcknowledgeBy "John Doe" -NoNotice
#
# Then approve the device on the dashboard: Overview → Approval queue → Approve.
#
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $CollectorHost,
    [Parameter(Mandatory = $true)][string] $Pin,
    [string] $CollectorPort = '8443',
    [string] $AgentExe,
    [string] $PythonPath,
    [string] $PythonSourceDir,
    [string] $StateDir = (Join-Path $env:PROGRAMDATA 'CTTIme'),
    [string] $TaskName = 'CTTIme Endpoint Visibility',
    [Parameter(Mandatory = $true)][string] $AcknowledgeBy,
    [switch] $NoNotice,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "! $text" -ForegroundColor Red; exit 1 }

if ($Pin -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Pin must be the 64-character SHA-256 fingerprint from the collector."
}

$StateDir = [IO.Path]::GetFullPath($StateDir)
$repoRoot = Split-Path -Parent $PSScriptRoot
$who = "$env:USERDOMAIN\$env:USERNAME"

# Normalize port
$PortList = @($CollectorPort -split '[,;\s]+' | Where-Object { $_ -ne '' } | Select-Object -Unique)
if ($PortList.Count -eq 0) { Fail "CollectorPort '$CollectorPort' contains no port." }
$PortArg = $PortList -join ','

$agentTokens = @('run', '--host', $CollectorHost, '--port', $PortArg,
                 '--pin', $Pin.ToLower(), '--state-dir', $StateDir,
                 '--acknowledge-by', $AcknowledgeBy)
if ($NoNotice) { $agentTokens += '--no-notice' }

# Determine the executable to run
if ($AgentExe) {
    if (-not (Test-Path -LiteralPath $AgentExe)) { Fail "No agent executable at $AgentExe" }
    $Execute = $AgentExe
    $ExecuteArgs = $agentTokens
    $ReadCommand = """$AgentExe"""
}
elseif ($PythonPath) {
    if (-not (Test-Path -LiteralPath $PythonPath)) { Fail "No python.exe at $PythonPath" }
    $Execute = $PythonPath
    $ExecuteArgs = @('-m', 'CTTIme_agent') + $agentTokens
    $ReadCommand = """$PythonPath"" -m CTTIme_agent"
}
else {
    # Try packaged exe first, then python on PATH
    $py = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($py) {
        $Execute = $py.Source
        $ExecuteArgs = @('-m', 'CTTIme_agent') + $agentTokens
        $ReadCommand = """$Execute"" -m CTTIme_agent"
    }
    else {
        Fail 'No CTTImeAgent.exe or python.exe found. Pass -AgentExe or -PythonPath.'
    }
}

Write-Host ''
Write-Host 'CTTIme agent registration' -ForegroundColor Cyan
Write-Host "  collector      $CollectorHost:$PortArg"
Write-Host "  state dir      $StateDir"
Write-Host "  acknowledge by $AcknowledgeBy"
Write-Host ""

if ($DryRun) {
    Write-Host '-DryRun: nothing was executed. Planned command:' -ForegroundColor Yellow
    Write-Host "  & $ReadCommand $($agentTokens -join ' ')"
    exit 0
}

# Verify agent is installed
$identityFile = Join-Path $StateDir 'identity.json'
if (-not (Test-Path -LiteralPath $identityFile)) {
    Fail "Agent not installed at $StateDir. Run install.ps1 first."
}

Push-Location (Split-Path -Parent $Execute)
try {
    Write-Host "Running: $ReadCommand $($agentTokens -join ' ')" -ForegroundColor Cyan
    & $Execute @ExecuteArgs
}
finally { Pop-Location }

if ($LASTEXITCODE -ne 0) {
    Fail "Registration failed with exit code $LASTEXITCODE. Check $StateDir\agent.log"
}

Write-Host ''
Write-Host 'Registration complete.' -ForegroundColor Green
Write-Host "The device is now enrolled and acknowledged as: $AcknowledgeBy"
Write-Host ''
Write-Host 'Next step — approve on the dashboard:' -ForegroundColor Yellow
Write-Host "  Open https://$CollectorHost:$PortArg"
Write-Host '  Go to Overview → Approval queue → click Approve'
Write-Host '  Then click Confirm this device to verify data is flowing.'
Write-Host ''
