import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { hostname, release, arch } from 'node:os';

// All agent state lives in one discoverable directory. Nothing is hidden, nothing is scattered
// through the registry, and uninstall removes exactly this tree.
export function resolveStateDir(override) {
  if (override) return path.resolve(override);
  const programData = process.env.PROGRAMDATA ?? process.env.ProgramData ?? 'C:\\ProgramData';
  return path.join(programData, 'CTTIme');
}

export function paths(stateDir) {
  return {
    root: stateDir,
    config: path.join(stateDir, 'config.json'),
    spool: path.join(stateDir, 'spool'),
    segments: path.join(stateDir, 'spool'),
    blobs: path.join(stateDir, 'blobs'),
    log: path.join(stateDir, 'agent.log'),
    token: path.join(stateDir, 'token.bin'),
    identity: path.join(stateDir, 'identity.json'),
    policy: path.join(stateDir, 'policy.json'),
    pending: path.join(stateDir, 'pending-shots'),
  };
}

export function ensureLayout(p) {
  for (const dir of [p.root, p.spool, p.blobs, p.pending]) mkdirSync(dir, { recursive: true });
}

export function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonFile(file, value) {
  // Write-then-rename would be the atomic choice on POSIX; on Windows the rename target must not
  // exist, so the small direct write is used with a single synchronous write to limit the window
  // in which a crash leaves a half-written config.
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function deviceIdentity() {
  return {
    hostname: hostname(),
    os_build: `${release()} ${arch()}`,
    // The device user is taken from the process environment rather than entered free-hand so it
    // can be cross-checked against the acknowledgment name at enrollment.
    device_user: process.env.USERNAME ?? process.env.USER ?? 'unknown',
  };
}
