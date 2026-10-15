
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Lock detection reads the desktop that is currently receiving input. When the workstation is
# locked (or a screensaver owns the desktop) that is "Winlogon" / "ScreenSaver", not "Default".
# A Get-Process LogonUI check was tried first and is wrong: LogonUI is resident on an unlocked
# session, which would have made this agent report every frame as locked and capture nothing
# while still looking healthy in the dashboard.
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeskApi {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr h, int idx, StringBuilder buf, uint len, out uint needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
}
'@

$idleSig = @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
'@

$out = @{ locked = $false; idle_seconds = 0; captured = $false; desktop = $null; error = $null }
try {
  try { Add-Type -TypeDefinition $sig } catch {}
  try { Add-Type -TypeDefinition $idleSig } catch {}

  $h = [DeskApi]::OpenInputDesktop(0, $false, 0x0001)
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 256
    $needed = 0
    [void][DeskApi]::GetUserObjectInformationW($h, 2, $sb, 256, [ref]$needed)
    [void][DeskApi]::CloseDesktop($h)
    $out.desktop = $sb.ToString()
    if ($out.desktop -and $out.desktop -ne 'Default') { $out.locked = $true }
  }
  # If the desktop cannot be read at all, $out.locked stays false and a capture happens. The
  # downside of that default is an occasional lock-screen image; the alternative is an agent that
  # silently stops recording, which is the worse failure.

  $li = New-Object Win+LASTINPUTINFO
  $li.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($li)
  if ([Win]::GetLastInputInfo([ref]$li)) {
    $ms = [int]([Environment]::TickCount) - [int]$li.dwTime
    if ($ms -lt 0) { $ms += [int][uint32]::MaxValue }
    $out.idle_seconds = [math]::Floor($ms / 1000)
  }

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
