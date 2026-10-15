# Removes the CTTIme endpoint agent: stops the scheduled task, then deletes its state directory.
#
# Run this on the device. It is the whole uninstall -- there is no service, no driver, no registry
# run key, and no second copy anywhere else, which is the point of keeping the install in one
# discoverable folder.
#
#   .\uninstall.ps1
#   .\uninstall.ps1 -KeepData          # remove the task, keep logs and spool for an audit
#   .\uninstall.ps1 -DryRun
#
# The collector still holds whatever it already received. Deleting the agent does not delete that
# data: revoke the device in the dashboard (which records a reason in the audit log) and use the
# export and retention controls there.
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $StateDir = (Join-Path $env:PROGRAMDATA 'CTTIme'),
    [string] $TaskName = 'CTTIme Endpoint Visibility',
    [switch] $KeepData,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Done($text) { Write-Host "  ok    $text" -ForegroundColor Green }
function Write-Skip($text) { Write-Host "  none  $text" -ForegroundColor DarkGray }
function Fail($text) { Write-Host "! $text" -ForegroundColor Red; exit 1 }

# This script deletes a directory tree, so the path is normalized and checked before anything is
# printed: "C:\ProgramData\CTTIme\" with its quote-eaten trailing slash must not become C:\ProgramData.
$StateDir = [IO.Path]::GetFullPath($StateDir.TrimEnd('\', '/'))
$root = [IO.Path]::GetPathRoot($StateDir)
if ($StateDir -eq $root) { Fail "Refusing to operate on a drive root: $StateDir" }

Write-Host ''
Write-Host 'CTTIme agent uninstall' -ForegroundColor Cyan
Write-Host "  task    $TaskName"
Write-Host "  state   $StateDir"
Write-Host ''
if ($DryRun) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "-DryRun: nothing was changed. Would:" -ForegroundColor Yellow
    if ($task) { Write-Host "  stop and unregister '$TaskName' (state $($task.State))" }
    else { Write-Host "  no scheduled task named '$TaskName'" }
    if (Test-Path -LiteralPath $StateDir) {
        Write-Host $(if ($KeepData) { "  keep $StateDir (-KeepData)" } else { "  delete $StateDir and everything under it" })
    } else { Write-Host "  no state directory at $StateDir" }
    exit 0
}

# 1. Stop it running, then remove the task so it cannot come back at next sign-in.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -ne 'Ready' -and $task.State -ne 'Disabled') { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Fail "Task '$TaskName' is still registered. Run this from the account that created it, or as an admin."
    }
    Write-Done "scheduled task '$TaskName' stopped and unregistered"
} else {
    Write-Skip "no scheduled task named '$TaskName'"
}

# 2. Remove the state directory. Guarded: a mistyped -StateDir must not be able to delete a
#    directory that was never ours, so the folder has to contain a recognizable artifact.
if (Test-Path -LiteralPath $StateDir) {
    $markers = @('agent\cli.js', 'agent-py\CTTIme_agent\cli.py', 'config.json', 'ABOUT.txt',
                 'agent.log', 'spool') |
        ForEach-Object { Join-Path $StateDir $_ }
    $looksOurs = @($markers | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
    if (-not $looksOurs) {
        Fail "$StateDir exists but contains no CTTIme files. Refusing to delete it; pass the right -StateDir."
    }
    if ($KeepData) {
        Write-Done "kept $StateDir (-KeepData): logs, spool and config remain for inspection"
    } else {
        Remove-Item -LiteralPath $StateDir -Recurse -Force
        if (Test-Path -LiteralPath $StateDir) { Fail "$StateDir still exists -- something has a file open in it." }
        Write-Done "deleted $StateDir (code, config, log, spool, blobs, DPAPI-sealed token)"
    }
} else {
    Write-Skip "no state directory at $StateDir"
}

# 3. Say plainly what is left, because "uninstalled" is not the same as "the data is gone".
Write-Host ''
Write-Host 'Done on this device.' -ForegroundColor Green
Write-Host 'Still outstanding, and deliberate:'
Write-Host '  * Data already uploaded stays on the collector until it ages out of retention or an'
Write-Host '    admin deletes it. Revoke the device in the dashboard so the revocation is audited.'
Write-Host '  * The collector keeps the device row (hostname, consent record, audit history) so the'
Write-Host '    approval trail survives the endpoint. That is a record of consent, not of activity.'
Write-Host ''
