$ErrorActionPreference = 'SilentlyContinue'
function Trunc($s, $n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' } return $s }

Write-Output '=== node processes (pid / ppid / created) ==='
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
  $grand = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)"
  Write-Output ("PID={0} created={1}" -f $p.ProcessId, $p.CreationDate)
  Write-Output ("  exe    : " + (Trunc $p.ExecutablePath 200))
  Write-Output ("  cwdHint: " + (Trunc $p.CommandLine 160))
  Write-Output ("  parent : {0} ({1}) / grand {2} ({3})" -f $parent.Name, $parent.ProcessId, $grand.Name, $grand.ProcessId)
}

Write-Output ''
Write-Output '=== established outbound connections for node pids ==='
foreach ($p in $procs) {
  Get-NetTCPConnection -OwningProcess $p.ProcessId -State Established |
    ForEach-Object { Write-Output ("PID={0} {1}:{2} -> {3}:{4}" -f $p.ProcessId, $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort) }
}

Write-Output ''
Write-Output '=== scheduled tasks registered/modified since 2026-09-01 ==='
Get-ScheduledTask | Where-Object { $_.Date -and ([datetime]$_.Date) -gt (Get-Date '2026-09-01') } |
  ForEach-Object {
    $a = ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
    Write-Output ("{0}  [{1}]  {2}" -f (Trunc $_.Date 24), $_.State, (Trunc ("$($_.TaskPath)$($_.TaskName) => $a") 300))
  }

Write-Output ''
Write-Output '=== autorun registry keys ==='
foreach ($hive in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
  $k = Get-Item $hive
  foreach ($n in $k.GetValueNames()) { Write-Output ("{0} :: {1} = {2}" -f $hive, $n, (Trunc $k.GetValue($n) 200)) }
}

Write-Output ''
Write-Output '=== startup folders ==='
foreach ($d in "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup") {
  Get-ChildItem $d -File | ForEach-Object { Write-Output ("{0}  {1} bytes  {2}" -f $_.FullName, $_.Length, $_.LastWriteTime) }
}

Write-Output ''
Write-Output '=== recent temp scripts ==='
Get-ChildItem $env:TEMP -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-14) -and ($_.Extension -in '.tmp', '.js', '.ps1', '.vbs', '.bat', '.cmd', '.lnk') } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 15 |
  ForEach-Object { Write-Output ("{0}  {1} bytes  {2}" -f $_.FullName, $_.Length, $_.LastWriteTime) }
