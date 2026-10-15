
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.InteropServices

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern uint GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("wtsapi32.dll")] public static extern int WTSGetActiveConsoleSessionId();
}
'@
try { Add-Type -TypeDefinition $sig -PassThru | Out-Null } catch {}

$out = @{ locked = $false; idle_seconds = 0; captured = $false; error = $null }
try {
  $li = New-Object Win+LASTINPUTINFO
  $li.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($li)
  if ([Win]::GetLastInputInfo([ref]$li)) {
    $ms = [uint32]([Environment]::TickCount) - $li.dwTime
    if ($ms -lt 0) { $ms += [uint32]::MaxValue }
    $out.idle_seconds = [math]::Floor($ms / 1000)
  }
  # LogonUI on the console session is the lock screen. Also treat a disconnected active console
  # session as locked: nobody is at the machine.
  if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { $out.locked = $true }
  try {
    $sess = [Win]::WTSGetActiveConsoleSessionId()
    if ($sess -eq 0xFFFFFFFF) { $out.locked = $true }
  } catch {}

  if (-not $out.locked) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($Args[0], [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $out.captured = $true
    $out.width = $b.Width; $out.height = $b.Height
  }
} catch { $out.error = $_.Exception.Message }
$out | ConvertTo-Json -Compress
