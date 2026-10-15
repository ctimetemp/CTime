import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

// DPAPI CurrentUser seal. The token is bound to this Windows user's master key, so a copy of
// token.bin taken to another account or another machine cannot be opened. It is not encryption
// against the logged-in user -- that is what CurrentUser scope means, and it is stated plainly in
// config.json rather than presented as stronger than it is.
//
// The secret travels to PowerShell over stdin, never as a command-line argument: process command
// lines are visible in the process list and in Sysmon EID 1 logs.
const PROTECT_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
if (-not $in) { exit 2 }
$bytes = [Convert]::FromBase64String($in)
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($sealed)
`;

const UNPROTECT_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
if (-not $in) { exit 2 }
$bytes = [Convert]::FromBase64String($in)
$open = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($open)
`;

function runPs(script, stdinData) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: stdinData, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`dpapi failed (${r.status}): ${(r.stderr ?? '').trim().slice(0, 200)}`);
  }
  return (r.stdout ?? '').trim();
}

export function sealToken(token, file) {
  const sealed = runPs(PROTECT_PS, Buffer.from(token, 'utf8').toString('base64'));
  writeFileSync(file, sealed, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* NTFS ACLs govern this; mode is best-effort */ }
  return file;
}

export function openToken(file) {
  if (!existsSync(file)) return null;
  const sealed = readFileSync(file, 'utf8').trim();
  if (!sealed) return null;
  try {
    return Buffer.from(runPs(UNPROTECT_PS, sealed), 'base64').toString('utf8') || null;
  } catch {
    // A different Windows user opened this process, or the master key rotated. The token is
    // unrecoverable by design; an admin must rotate it.
    return null;
  }
}

export function dpapiAvailable() {
  try {
    const probe = runPs(PROTECT_PS, Buffer.from('probe', 'utf8').toString('base64'));
    return probe.length > 0;
  } catch {
    return false;
  }
}
