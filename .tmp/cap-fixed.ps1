
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
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  // Idle milliseconds, or -1 when it cannot be determined.
  //
  // LASTINPUTINFO.dwTime is a 32-bit tick counter that wraps after ~24.85 days of uptime, so the
  // difference has to be taken in that same unsigned domain. The previous version subtracted as
  // signed Int32 and then tried to repair the wrap with [int][uint32]::MaxValue -- a conversion
  // Windows PowerShell rejects outright. That throw landed in the script's single catch, which sat
  // *after* the capture block, so every long-uptime host stopped taking screenshots while still
  // reporting a perfectly healthy 'active' state to the dashboard.
  // GetTickCount64 never wraps in practice; masking it back to 32 bits puts it in dwTime's domain,
  // and the +2^32 correction recovers the true gap whenever the last input was inside the previous
  // wrap, which is any machine someone actually sits at.
  public static long IdleMillis() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    return DeltaMillis(li.dwTime, GetTickCount64());
  }

  // Split out so the wrap case is testable without waiting 24.85 days for a reboot uptime.
  public static long DeltaMillis(uint lastInputTick, ulong nowTick64) {
    long now = (long)(nowTick64 & 0xFFFFFFFFUL);
    long delta = now - (long)lastInputTick;
    if (delta < 0) delta += 0x100000000L;
    return delta;
  }
}
'@

$out = @{ locked = $false; idle_seconds = 0; idle_probe = 'ok'; desktop_probe = 'ok'
          captured = $false; desktop = $null; error = $null }
try {
  try { Add-Type -TypeDefinition $sig } catch {}
  try { Add-Type -TypeDefinition $idleSig } catch {}

  # Each probe gets its own error boundary. They share one outer catch in this script, and that
  # catch sits after the capture block -- so a throw while reading the desktop or the idle counter
  # used to cancel the screenshot for that tick and leave only a generic 'active' state behind.
  # Unreadable state must mean "capture anyway", never "record nothing".
  try {
    $h = [DeskApi]::OpenInputDesktop(0, $false, 0x0001)
    if ($h -ne [IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 256
      $needed = 0
      [void][DeskApi]::GetUserObjectInformationW($h, 2, $sb, 256, [ref]$needed)
      [void][DeskApi]::CloseDesktop($h)
      $out.desktop = $sb.ToString()
      if ($out.desktop -and $out.desktop -ne 'Default') { $out.locked = $true }
    } else {
      $out.desktop_probe = 'unavailable'
    }
  } catch { $out.desktop_probe = 'error' }
  # If the desktop cannot be read at all, $out.locked stays false and a capture happens. The
  # downside of that default is an occasional lock-screen image; the alternative is an agent that
  # silently stops recording, which is the worse failure.

  try {
    $idleMs = [Win]::IdleMillis()
    if ($idleMs -ge 0) {
      $out.idle_seconds = [math]::Floor($idleMs / 1000.0)
    } else {
      $out.idle_probe = 'unavailable'
    }
  } catch { $out.idle_probe = 'error' }
  # An unknown idle value lands on 0, which is "someone is at this desk": the frame is captured and
  # the reason is reported through idle_probe instead of silently suppressing frames forever.

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
