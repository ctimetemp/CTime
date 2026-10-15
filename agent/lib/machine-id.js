import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

// Windows exposes a stable per-installation identifier at
//   HKLM\SOFTWARE\Microsoft\Cryptography  MachineGuid
// which any admin can read with `reg query`. It is the same value MDM and asset-inventory
// tooling use, so it is used here openly rather than reconstructed from hidden sources.
export function readMachineGuid() {
  const run = (file, args) => execFileSync(file, args, {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const candidates = [
    () => run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
    () => run('powershell', ['-NoProfile', '-Command',
      '(Get-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid']),
  ];
  for (const attempt of candidates) {
    try {
      const out = attempt();
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out);
      const value = m ? m[1] : String(out).trim();
      if (value && value.length >= 8 && !/ERROR|Cannot find/i.test(value)) return value;
    } catch { /* try the next reader */ }
  }
  return null;
}

// Only used when the registry value is unavailable -- a non-Windows dev host, or a restricted
// hive. Persisted to the state directory so identity at least stays stable on that box; without
// persistence every restart would enroll a brand-new device row.
export function persistedFallbackId(file) {
  if (file && existsSync(file)) {
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing) return { id: existing, source: 'file' };
    } catch { /* regenerate */ }
  }
  const id = createHash('sha256')
    .update(`${randomUUID()}|${process.env.COMPUTERNAME ?? 'unknown-host'}`).digest('hex');
  if (file) {
    try { writeFileSync(file, id, 'utf8'); } catch { /* non-persistent for this run only */ }
  }
  return { id, source: 'generated' };
}

export function smbUuid() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-fA-F-]{32,36}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
