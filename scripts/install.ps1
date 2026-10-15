# Installs the CTTIme endpoint agent as a named, visible per-user scheduled task.
#
# Read this before running it. The agent is monitoring software: it uploads screenshots of the
# signed-in user's desktop, browser extension inventory, and clipboard metrics (character count,
# hash and a coarse kind label -- never the text). It must not be deployed on a device whose users
# have not been told it exists and have not acknowledged the notice in writing. The collector
# enforces that: enrollment is refused without an acknowledgment, and no data is accepted from a
# device that is not approved.
#
# Nothing here hides. The task appears in Task Scheduler and in `schtasks /query`, the code and
# state live in one folder under %PROGRAMDATA%\CTTIme, the agent writes a plaintext log, and
# uninstall.ps1 removes exactly that.
#
#   .\install.ps1 -CollectorHost 10.1.2.3 -Pin <64-hex-fingerprint>
#   .\install.ps1 -CollectorHost 10.1.2.3 -Pin <fingerprint> -Acknowledge
#   .\install.ps1 -CollectorHost 10.1.2.3 -Pin <fingerprint> -DryRun
#
# -Acknowledge shows the notice and asks for the device user's own name. Run it as that user, in
# that user's session. An agent installed without it simply stays unenrolled and collects nothing.
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $CollectorHost,
    # One port, or a comma-separated list. Every listener on the collector carries the same
    # certificate and serves the same routes, so extra ports are availability (one of them can be
    # blocked by a local firewall rule without blinding the device) -- never identity, which stays
    # the pinned SHA-256 fingerprint.
    [string] $CollectorPort = '8443',
    [Parameter(Mandatory = $true)][string] $Pin,
    [string] $NodePath,
    [string] $SourceDir,
    # Two clients ship from this repository and the device runs one of them. 'node' is the default
    # and needs node.exe; 'python' runs the standard-library client either from python.exe or from
    # the packaged CTTImeAgent.exe, which needs no Python install on the device.
    [ValidateSet('node', 'python')][string] $Client = 'node',
    [string] $PythonPath,
    [string] $AgentExe,
    [string] $PythonSourceDir,
    [string] $StateDir = (Join-Path $env:PROGRAMDATA 'CTTIme'),
    [string] $TaskName = 'CTTIme Endpoint Visibility',
    [switch] $Acknowledge,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "! $text" -ForegroundColor Red; exit 1 }

if ($Pin -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Pin must be the 64-character SHA-256 fingerprint the collector prints at startup. Get it with: node scripts/make-cert.js --check"
}
if (-not $CollectorHost) { Fail 'CollectorHost is required.' }
$PortList = @($CollectorPort -split '[,;\s]+' | Where-Object { $_ -ne '' } | Select-Object -Unique)
if ($PortList.Count -eq 0) { Fail "CollectorPort '$CollectorPort' contains no port." }
foreach ($p in $PortList) {
    if ($p -notmatch '^\d{1,5}$' -or [int]$p -lt 1 -or [int]$p -gt 65535) {
        Fail "CollectorPort '$p' is not a port (1-65535)."
    }
}
# One argument either way: the agent reads --port as a list and tries them in order, so a single
# port and a port set take the same path and cannot drift apart.
$PortArg = $PortList -join ','
$CollectorUrls = ($PortList | ForEach-Object { "https://${CollectorHost}:$_" }) -join '   or   '

# A quoted trailing backslash ("C:\ProgramData\CTTIme\") arrives with the slash eaten by the
# command-line parser, which would install into the parent directory. Normalize before using it.
$StateDir = [IO.Path]::GetFullPath($StateDir)
if (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($StateDir)))) { Fail "StateDir has no reachable root: $StateDir" }

$repoRoot = Split-Path -Parent $PSScriptRoot
$who = "$env:USERDOMAIN\$env:USERNAME"
# --state-dir is passed explicitly rather than left to the default. Without it, an install aimed
# anywhere other than %PROGRAMDATA%\CTTIme would scatter its state into the default directory,
# and uninstall.ps1 -StateDir would then delete a folder that was never the one in use.
$agentTokens = @('run', '--host', $CollectorHost, '--port', $PortArg,
                 '--pin', $Pin.ToLower(), '--state-dir', $StateDir)
# --resident belongs to the task alone. It suppresses the console window the task would otherwise
# leave on the desktop for the life of the process, and changes nothing else. The same command run
# by hand -- the -Acknowledge call below, or anything a person types -- keeps its window, because
# that window is the terminal they are working in.
$taskTokens = @($agentTokens) + '--resident'
$agentArgs = ($taskTokens | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { [string]$_ }
}) -join ' '

if ($Client -eq 'python') {
    if (-not $PythonSourceDir) { $PythonSourceDir = Join-Path $repoRoot 'client-py' }
    if (-not (Test-Path -LiteralPath (Join-Path $PythonSourceDir 'CTTIme_agent\cli.py'))) {
        Fail "No Python client at $PythonSourceDir (expected CTTIme_agent\cli.py there)."
    }
    $agentDir = Join-Path $StateDir 'agent-py'
    $cliPath = Join-Path $agentDir 'CTTIme_agent\cli.py'
    if ($AgentExe) {
        if (-not (Test-Path -LiteralPath $AgentExe)) { Fail "No agent executable at $AgentExe" }
        $Execute = $AgentExe
        $Arguments = $agentArgs
        $ExecuteArgs = $agentTokens
        $ReadCommand = """$AgentExe"""
    }
    else {
        if (-not $PythonPath) {
            $py = Get-Command python.exe -ErrorAction SilentlyContinue
            if (-not $py) {
                Fail 'python.exe not found on PATH. Pass -PythonPath C:\path\to\python.exe, or -AgentExe with the packaged CTTImeAgent.exe.'
            }
            $PythonPath = $py.Source
        }
        elseif (-not (Test-Path -LiteralPath $PythonPath)) { Fail "No python.exe at $PythonPath" }
        $Execute = $PythonPath
        # -m puts the working directory on sys.path, so the copied package is the one that runs.
        $Arguments = "-m CTTIme_agent $agentArgs"
        $ExecuteArgs = @('-m', 'CTTIme_agent') + $agentTokens
        $ReadCommand = """$PythonPath"" -m CTTIme_agent  (from $agentDir)"
    }
}
else {
    if (-not $NodePath) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) { Fail 'node.exe not found on PATH. Pass -NodePath C:\path\to\node.exe' }
        $NodePath = $node.Source
    }
    elseif (-not (Test-Path -LiteralPath $NodePath)) { Fail "No node.exe at $NodePath" }

    # The agent runs with `node cli.js ...` from inside its own directory, so the install tree has
    # to carry package.json (it declares "type": "module") alongside agent/.
    if (-not $SourceDir) { $SourceDir = Join-Path $repoRoot 'agent' }
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'cli.js'))) { Fail "No agent at $SourceDir (expected cli.js there)." }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) { Fail "package.json is missing next to $repoRoot; copy it with the agent." }

    $agentDir = Join-Path $StateDir 'agent'
    $cliPath = Join-Path $agentDir 'cli.js'
    $Execute = $NodePath
    $Arguments = "cli.js $agentArgs"
    $ExecuteArgs = @('cli.js') + $agentTokens
    $ReadCommand = """$NodePath"" ""$cliPath"""
}
$WorkingDirectory = $agentDir

Write-Host ''
Write-Host 'CTTIme agent install' -ForegroundColor Cyan
Write-Host "  collector      $CollectorUrls"
Write-Host "  certificate    pinned to $($Pin.ToLower()) (no fallback, no downgrade)"
Write-Host "  client         $Client$(if ($AgentExe) { ' (packaged executable)' })"
Write-Host "  runs as        $who, limited privileges (not admin)"
Write-Host "  when           at sign-in, in the user's own session, re-checked every 5 minutes"
Write-Host "  code + state   $StateDir"
Write-Host "  log            $(Join-Path $StateDir 'agent.log')"
Write-Host "  task name      $TaskName"
Write-Host ''

if ($DryRun) {
    Write-Host '-DryRun: nothing was created. Planned steps:' -ForegroundColor Yellow
    if ($Client -eq 'node') { Write-Step "copy $SourceDir and package.json to $agentDir" }
    else { Write-Step "copy $PythonSourceDir to $agentDir" }
    Write-Step "write ABOUT.txt (disclosure note) into $StateDir"
    Write-Step "register the scheduled task (at logon, then re-checked every 5 minutes) with: `"$Execute`" $Arguments"
    Write-Step 'start the task'
    if ($Acknowledge) { Write-Step 'show the notice and prompt for acknowledgment' }
    exit 0
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
if ($Client -eq 'node') {
    Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination $agentDir -Force
    Copy-Item -Path (Join-Path $SourceDir '*') -Destination $agentDir -Recurse -Force
}
else {
    # The .py sources go onto the device as ordinary readable files, and a build's __pycache__
    # does not travel with them.
    Get-ChildItem -LiteralPath $PythonSourceDir -Force |
        Where-Object { $_.Name -ne '__pycache__' } |
        Copy-Item -Destination $agentDir -Recurse -Force
    Get-ChildItem -LiteralPath $agentDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# A file the device user can open and read, naming the program, what it does, and how to stop it.
$about = @"
CTTIme endpoint agent
======================

What runs here      A disclosed monitoring agent for company-managed Windows devices.
Scheduled task      "$TaskName" -- visible in Task Scheduler and: schtasks /query /tn "$TaskName"
Runs as             $who, limited privileges, only while that user is signed in.
When                at sign-in, then re-checked every 5 minutes so it resumes by itself after a
                    collector outage. It waits in place and captures nothing while the consent
                    gate is shut; stopping it with schtasks /end only lasts until the next check.
What it collects    Screenshots on the interval set by the collector, browser extension
                    inventory, and clipboard METRICS ONLY (character count, a SHA-256 of the
                    clipboard contents taken in memory, and a coarse kind label). Clipboard
                    text is never transmitted, logged or written to disk by this program.
                    Screenshots are never analysed with OCR or image recognition.
Where it sends      $CollectorUrls over TLS, pinned to this
                    certificate SHA-256 fingerprint: $($Pin.ToLower())
                    Nothing else presenting that address is accepted. There is no plaintext
                    fallback and no downgrade. More than one address is allowed: they are the same
                    collector, and using a second port does not change what is trusted.
On your screen      A short notice appears in the corner of your desktop when this agent loses the
                    collector, gets it back after a gap, or finds a certificate that does not match
                    the one it was given. It never asks you to approve anything -- the notice you
                    acknowledged at install is separate, and the agent keeps running while no
                    notice can be shown, recording that it could not tell you.
No window           The running agent opens no console window. That is not it being hidden from
                    you: the same facts are in the scheduled task list, in the files in this
                    folder, and in the two commands under "Read it" below.
Local state         config.json, policy.json, identity.json, agent.log, spool\, blobs\
                    Events and screenshots that cannot be uploaded are buffered in spool\ and
                    blobs\ on this machine and sent when the collector answers; they are deleted
                    from here only after the collector has accepted them.
Read it             $ReadCommand what-collects --state-dir "$StateDir"
                    $ReadCommand status --state-dir "$StateDir"
Troubleshoot it     $ReadCommand check --host $CollectorHost --port $PortArg --pin $($Pin.ToLower()) --state-dir "$StateDir"
                    Proves the socket, the pin, the notice and the enrollment gate, captures
                    nothing, and exits. It is safe to run while the agent is already working.
Stop it             schtasks /end /tn "$TaskName" stops the current run only -- the 5-minute
                    check starts it again. To pause it for good, disable the task:
                    Disable-ScheduledTask -TaskName "$TaskName"
Remove it           uninstall.ps1 in this folder, or:
                    powershell -File "$([string](Join-Path $repoRoot 'scripts\uninstall.ps1'))"

Consent gate        Nothing is collected until the device user acknowledges the monitoring
                    notice and an administrator approves the device. Until then the agent
                    reports "consent_required" and uploads nothing. Declining writes
                    DECLINED.txt and collects nothing at all.
"@
Set-Content -LiteralPath (Join-Path $StateDir 'ABOUT.txt') -Value $about -Encoding UTF8

# Register-ScheduledTask with a user principal and no password stores the task as "run only when
# the user is logged on". That is deliberate: the task has no stored credential to harvest, cannot
# run in a detached session, and stops being useful the moment the user signs out.
$action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $WorkingDirectory
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $who),
    # Repetition is what resumes collection after the collector was down, after a crash, or after
    # an acknowledgment typed into a window this process never saw. The agent waits in place when
    # it is already running, so this trigger is a floor on how long a device can stay dark -- not
    # a way to run it alongside itself: -MultipleInstances IgnoreNew covers that. No
    # -RepetitionDuration, which leaves the repetition open-ended rather than ending on a date.
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
        -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description 'Disclosed endpoint monitoring agent (CTTIme). Runs only while the named user is signed in, and is re-checked every 5 minutes so it resumes by itself after a collector outage. Collects nothing until the device user acknowledges the notice and an administrator approves this device. See %PROGRAMDATA%\CTTIme\ABOUT.txt; remove with uninstall.ps1.' | Out-Null

Start-ScheduledTask -TaskName $TaskName

$state = (Get-ScheduledTask -TaskName $TaskName).State
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "  registered     $state (last run: $($info.LastRunTime))" -ForegroundColor Green
Write-Host ''

if ($Acknowledge) {
    Write-Host 'Showing the notice to the signed-in user. This must be the device user themselves.' -ForegroundColor Yellow
    Push-Location $agentDir
    try {
        & $Execute @($ExecuteArgs + @('--interactive'))
    } finally { Pop-Location }
} else {
    Write-Host 'Not enrolled yet: the agent will show the notice and collect nothing until'
    Write-Host "the device user acknowledges it. To do that now, re-run with -Acknowledge, or:"
    Write-Host "  $ReadCommand run --host $CollectorHost --port $CollectorPort --pin $Pin --state-dir `"$StateDir`" --interactive"
}

Write-Host ''
Write-Host 'Verify:'
Write-Host "  schtasks /query /tn `"$TaskName`" /v /fo LIST   (note: Run As User = $who, Run Level = Limited)"
Write-Host "  $ReadCommand status --state-dir `"$StateDir`""
Write-Host "  $ReadCommand what-collects --state-dir `"$StateDir`""
Write-Host "  type `"$(Join-Path $StateDir 'agent.log')`""
Write-Host 'Then approve the device in the dashboard; it sits in the approval queue until you do.'
Write-Host ''
