$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
if (-not $in) { exit 2 }
$bytes = [Convert]::FromBase64String($in)
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($sealed)
