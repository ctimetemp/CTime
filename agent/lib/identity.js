import { createHash } from 'node:crypto';
import path from 'node:path';
import { readMachineGuid, persistedFallbackId, smbUuid } from './machine-id.js';

// Identifies the device, not the person, and is stable across agent reinstalls and OS renames.
// Every input here is already readable by anyone with access to the machine, so the fingerprint
// is not a secret and is never used as an authenticator on its own -- the bearer token is.
export function deviceFingerprint(stateDir) {
  const guidFile = path.join(stateDir, 'machine-id.fallback');
  const guid = readMachineGuid();
  const source = guid ? { id: guid, source: 'registry' } : persistedFallbackId(guidFile);
  const parts = [source.id];
  const uuid = smbUuid();
  if (uuid) parts.push(uuid);
  return {
    fingerprint: createHash('sha256').update(parts.join('|')).digest('hex'),
    source: source.source,
    hasSmbUuid: Boolean(uuid),
  };
}
