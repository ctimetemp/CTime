import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { createSelfSigned, fingerprintOfPem } from './x509.js';

// Overridable so a test harness or a second collector on this box can keep its state out of the
// production directory.
export const DATA = process.env.CTTIme_DATA
  ? path.resolve(process.env.CTTIme_DATA)
  : path.resolve(import.meta.dirname, '../data');

// The certificate is created on first boot so a fresh install has no ceremony, and reused on
// every later boot so agents keep a stable pin. Regenerating it silently would brick every
// pinned agent on the LAN, so a key/cert pair on disk is only ever replaced by an explicit
// --rotate-cert, never by an error at startup.
export function loadOrGenerateCert(dir, { forceNew = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  if (!forceNew && existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    try {
      return { cert, key, fingerprint: fingerprintOfPem(cert), reused: true, certPath, keyPath };
    } catch { /* fall through to generation */ }
  }
  const local = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) local.push(entry.address);
    }
  }
  const cert = createSelfSigned({
    ips: local,
    hosts: [hostnameSafe()],
    days: 3650,
  });
  writeFileSync(certPath, cert.certPem, { mode: 0o600 });
  writeFileSync(keyPath, cert.keyPem, { mode: 0o600 });
  writeFileSync(path.join(dir, 'fingerprint.txt'), `${cert.fingerprint}\n`);
  return { cert: cert.certPem, key: cert.keyPem, fingerprint: cert.fingerprint,
    reused: false, certPath, keyPath };
}

function hostnameSafe() {
  try { return (process.env.COMPUTERNAME || '').toLowerCase() || undefined; } catch { return undefined; }
}
