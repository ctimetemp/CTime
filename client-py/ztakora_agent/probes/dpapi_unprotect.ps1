$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
if (-not $in) { exit 2 }
$bytes = [Convert]::FromBase64String($in)
$open = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($open)
