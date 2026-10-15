
$ErrorActionPreference = 'Stop'
$out = @{ shown = $false; via = 'none'; error = $null }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $icon.BalloonTipTitle = [string]$Args[0]
  $icon.BalloonTipText = [string]$Args[1]
  $icon.Visible = $true
  $icon.ShowBalloonTip([int]$Args[2])
  # A balloon is only painted while the thread pumps messages. Without this loop the call returns,
  # the icon is disposed, and the shell never draws anything -- which is exactly the silent failure
  # this module exists to prevent.
  $until = (Get-Date).AddSeconds(([int]$Args[2] / 1000) + 2)
  while ((Get-Date) -lt $until) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
  $icon.Visible = $false
  $icon.Dispose()
  $out.shown = $true
  $out.via = 'balloon'
} catch {
  $out.error = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
