import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Capture is a PowerShell child process using System.Drawing and Win32. No native Node module is
// loaded, which is what keeps the agent installable on a box with no build toolchain.
//
// The probe and the capture happen in one invocation: the session state has to be read at the
// moment of capture or the "we skipped this frame because it was locked" claim is about some
// other moment. The harness imports this string directly so the wrapped-tick case is proven against
// the script that actually ships, not against a copy of the arithmetic in the test file.
export const CAPTURE_SCRIPT = String.raw`
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
`;

export function createCapturer({ workDir, onWarn = () => {} }) {
  mkdirSync(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'capture.ps1');
  writeFileSync(scriptPath, CAPTURE_SCRIPT, 'utf8');

  function run(targetFile, timeoutMs) {
    return new Promise((resolveP) => {
      const child = spawn('powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, targetFile],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolveP({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          onWarn(`capture exited ${code}: ${stderr.slice(0, 200)}`);
          resolveP({ ok: false, error: stderr.slice(0, 200) || `exit ${code}` });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolveP({ ok: true, ...parsed });
        } catch (err) {
          resolveP({ ok: false, error: `bad probe output: ${err.message}` });
        }
      });
    });
  }

  // Returns { state: 'locked'|'idle'|'active', captured: bool, png?: Buffer, width, height }
  // A skip is a recorded decision, not a silence: the caller emits a screen_state event so the
  // dashboard can show why there is no image.
  //
  // 'idle' and 'locked' are only claimed when the probe that decided them actually answered. A
  // failed probe reports idle_probe/desktop_probe and falls through to a capture, because the
  // alternative -- an agent that quietly stops recording on a host whose counters misbehave -- is
  // indistinguishable from an agent that was never installed.
  async function capture({ idleSkipSeconds, skipWhenLocked, timeoutMs = 25000 }) {
    const target = path.join(workDir, `${randomUUID()}.png`);
    const res = await run(target, timeoutMs);
    if (!res.ok) {
      if (existsSync(target)) rmSync(target, { force: true });
      return { state: 'active', captured: false, reason: res.error };
    }
    if (res.idle_probe && res.idle_probe !== 'ok') {
      onWarn(`idle probe ${res.idle_probe}; capturing without an idle verdict`);
    }
    if (res.desktop_probe && res.desktop_probe !== 'ok') {
      onWarn(`desktop probe ${res.desktop_probe}; lock check skipped`);
    }
    if (skipWhenLocked !== false && res.locked) {
      if (existsSync(target)) rmSync(target, { force: true });
      return { state: 'locked', captured: false, idleSeconds: res.idle_seconds };
    }
    // Only a probe that answered may veto a frame. A missing flag counts as answered so the gate
    // cannot be switched off by a shape change in the script.
    const idleKnown = res.idle_probe !== 'error' && res.idle_probe !== 'unavailable';
    if (idleKnown && Number.isFinite(idleSkipSeconds) && idleSkipSeconds >= 0
      && res.idle_seconds > idleSkipSeconds) {
      if (existsSync(target)) rmSync(target, { force: true });
      return { state: 'idle', captured: false, idleSeconds: res.idle_seconds };
    }
    if (!res.captured) {
      return { state: 'active', captured: false, reason: res.error ?? 'no capture' };
    }
    let png = null;
    try { png = readFileSync(target); } finally { rmSync(target, { force: true }); }
    if (!png || png.length === 0) return { state: 'active', captured: false, reason: 'empty png' };
    return {
      state: 'active', captured: true, png, width: res.width, height: res.height,
      idleSeconds: res.idle_seconds,
    };
  }

  async function probe(timeoutMs = 12000) {
    const target = path.join(workDir, `probe-${randomUUID()}.png`);
    // The probe path still needs a capture target; the file is removed if one was written.
    const res = await run(target, timeoutMs);
    if (existsSync(target)) rmSync(target, { force: true });
    if (!res.ok) return null;
    // The probe flags travel out with the verdict so `check` can say "idle detection is not
    // answering on this host" instead of reporting a clean-looking 0 seconds idle.
    return {
      locked: Boolean(res.locked),
      idleSeconds: Number(res.idle_seconds) || 0,
      idleProbe: res.idle_probe ?? 'ok',
      desktopProbe: res.desktop_probe ?? 'ok',
    };
  }

  return { capture, probe, scriptPath };
}
