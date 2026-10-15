Add-Type -TypeDefinition @'
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
$r = @{}
$r['0'] = [Win]::DeltaMillis([uint32]1000, [uint64]61000)
$r['1'] = [Win]::DeltaMillis([uint32]3000000000, [uint64]3000060000)
$r['2'] = [Win]::DeltaMillis([uint32]4294900000, [uint64]50000)
$r['3'] = [Win]::DeltaMillis([uint32]4294967096, [uint64]200)
$r['live'] = [Win]::IdleMillis()
$r | ConvertTo-Json -Compress