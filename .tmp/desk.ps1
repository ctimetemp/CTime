Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Desk {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr h, int idx, IntPtr buf, uint len, out uint needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  public const int UOI_NAME = 2;
}
'@
$h = [Desk]::OpenInputDesktop(0, $false, 0x0001)
if ($h -eq [IntPtr]::Zero) { Write-Output "OpenInputDesktop failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit }
$needed = 0
[void][Desk]::GetUserObjectInformation($h, 2, [IntPtr]::Zero, 0, [ref]$needed)
$buf = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$needed)
[void][Desk]::GetUserObjectInformation($h, 2, $buf, $needed, [ref]$needed)
$name = [Runtime.InteropServices.Marshal]::PtrToStringUni($buf)
[void][Desk]::CloseDesktop($h)
Write-Output ("input desktop = '" + $name + "'  locked=" + ($name -ne 'Default'))
