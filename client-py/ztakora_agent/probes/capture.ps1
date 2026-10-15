param([Parameter(Mandatory = $true)][string] $OutFile)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Lock detection reads the desktop that is currently receiving input. When the workstation is
# locked (or a screensaver owns the desktop) that is "Winlogon" / "ScreenSaver", not "Default".
# A Get-Process LogonUI check was tried first and is wrong: LogonUI is resident on an unlocked
# session, which would make this report every frame as locked and capture nothing while still
# looking healthy in the dashboard.
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
  // signed Int32 and then repaired the wrap with [int][uint32]::MaxValue -- a conversion Windows
  // PowerShell rejects outright. That throw landed in this script's single catch, which sits
  // *after* the capture block, so long-uptime hosts stopped producing frames entirely.
  public static long IdleMillis() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    return DeltaMillis(li.dwTime, GetTickCount64());
  }

  // Split out so the wrap case is testable without 24.85 days of uptime.
  public static long DeltaMillis(uint lastInputTick, ulong nowTick64) {
    long now = (long)(nowTick64 & 0xFFFFFFFFUL);
    long delta = now - (long)lastInputTick;
    if (delta < 0) delta += 0x100000000L;
    return delta;
  }
}
'@

$out = @{ locked = $false; idle_seconds = 0; idle_probe = 'ok'; desktop_probe = 'ok'
          captured = $false; desktop = $null; error = $null;
          width = 0; height = 0; gray_cells = @() }
try {
  try { Add-Type -TypeDefinition $sig } catch {}
  try { Add-Type -TypeDefinition $idleSig } catch {}

  # Each probe gets its own error boundary. The one outer catch in this script sits after the
  # capture block, so a throw while reading session state used to cancel the frame for that tick
  # and leave only a generic state behind. Unreadable state must mean "capture anyway".
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
  # If the desktop cannot be read at all, locked stays false and a capture happens. The downside of
  # that default is an occasional lock-screen image; the alternative is an agent that silently
  # stops recording, which is the worse failure.

  try {
    $idleMs = [Win]::IdleMillis()
    if ($idleMs -ge 0) {
      $out.idle_seconds = [math]::Floor($idleMs / 1000.0)
    } else {
      $out.idle_probe = 'unavailable'
    }
  } catch { $out.idle_probe = 'error' }
  # An unknown idle value lands on 0, which reads as "someone is at this desk": the frame is
  # captured and the reason travels out through idle_probe instead of suppressing frames forever.

  if (-not $out.locked) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.width = $b.Width
    $out.height = $b.Height

    # 9x8 grayscale downsample for the perceptual hash, computed here while the bitmap is open so
    # the parent never decodes a frame. These are 72 brightness numbers; no image leaves this
    # process through this path.
    $small = New-Object System.Drawing.Bitmap 9, 8, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, 9, 8))
    $sg.Dispose()
    $cells = New-Object System.Collections.Generic.List[int]
    for ($y = 0; $y -lt 8; $y++) {
      for ($x = 0; $x -lt 9; $x++) {
        $p = $small.GetPixel($x, $y)
        $cells.Add([int][math]::Floor(0.2126 * $p.R + 0.7152 * $p.G + 0.0722 * $p.B + 0.5))
      }
    }
    $small.Dispose()
    $out.gray_cells = $cells.ToArray()

    $g.Dispose(); $bmp.Dispose()
    $out.captured = $true
  }
} catch { $out.error = $_.Exception.Message }
$out | ConvertTo-Json -Compress
