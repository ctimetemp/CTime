Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Desk2 {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr h, int idx, StringBuilder buf, uint len, out uint needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
}
'@
$h=[Desk2]::OpenInputDesktop(0,$false,0x0001)
if ($h -eq [IntPtr]::Zero) { Write-Output "fail $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit }
$sb = New-Object System.Text.StringBuilder 256
$needed = 0
[void][Desk2]::GetUserObjectInformationW($h, 2, $sb, 256, [ref]$needed)
$name = $sb.ToString()
[void][Desk2]::CloseDesktop($h)
Write-Output ("desktop='" + $name + "' locked=" + ($name -ne 'Default'))
