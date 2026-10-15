import { createHash } from 'node:crypto';

// Keys the agent is allowed to receive. collector_bind/collector_port are stored but never
// served: publishing them over a route the agent polls would let a policy write move the agent
// to a different host, and they are the server's own listen address anyway.
export const AGENT_POLICY_KEYS = [
  'screenshot_interval_minutes', 'screenshot_retention_days', 'screenshot_max_bytes',
  'clipboard_metrics_enabled', 'extension_inventory_enabled', 'notice_version',
  'clipboard_sample_seconds',
  'heartbeat_interval_seconds', 'batch_max_items', 'batch_max_bytes', 'batch_max_age_seconds',
  'spool_max_bytes', 'skip_when_locked', 'idle_skip_seconds', 'dedupe_unchanged_frames',
  'ext_inventory_max_age_hours',
];

export const ADMIN_WRITABLE_KEYS = [...AGENT_POLICY_KEYS].filter((k) => k !== 'notice_version');

// Bounds exist so an admin typo cannot publish a policy that self-DDoSes the LAN:
// screenshot_interval_minutes=0 would make every agent capture continuously.
export const BOUNDS = {
  screenshot_interval_minutes: [1, 1440],
  screenshot_retention_days: [1, 365],
  screenshot_max_bytes: [65536, 33554432],
  heartbeat_interval_seconds: [30, 3600],
  clipboard_sample_seconds: [15, 3600],
  batch_max_items: [1, 1000],
  batch_max_bytes: [8192, 4194304],
  batch_max_age_seconds: [10, 3600],
  spool_max_bytes: [8388608, 1073741824],
  idle_skip_seconds: [0, 86400],
  ext_inventory_max_age_hours: [1, 720],
};

const BOOL_KEYS = [
  'clipboard_metrics_enabled', 'extension_inventory_enabled', 'skip_when_locked',
  'dedupe_unchanged_frames',
];

const STRING_KEYS = ['notice_version'];

function coerce(kind, raw) {
  if (kind === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  }
  if (kind === 'int') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isInteger(n) ? n : null;
  }
  if (kind === 'string') return typeof raw === 'string' ? raw : null;
  return null;
}

function kindOf(key) {
  if (BOOL_KEYS.includes(key)) return 'bool';
  if (STRING_KEYS.includes(key)) return 'string';
  return 'int';
}

export function readPolicy(db) {
  const rows = db.prepare('SELECT key, value FROM policy').all();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of AGENT_POLICY_KEYS) {
    if (!byKey.has(key)) continue;
    const v = coerce(kindOf(key), byKey.get(key));
    if (v === null) throw new Error(`policy key ${key} holds an unparseable value`);
    out[key] = v;
  }
  return out;
}

// Canonical form for hashing: sorted keys, no whitespace. Stable across processes and Node
// versions, which an object-literal key order would not be once values are built by diffing.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function etagOf(policy) {
  return `"${createHash('sha256').update(canonical(policy)).digest('hex').slice(0, 16)}"`;
}

export function policyDocument(db) {
  const policy = readPolicy(db);
  return { policy, etag: etagOf(policy) };
}

export function validatePolicyWrite(key, value) {
  if (!ADMIN_WRITABLE_KEYS.includes(key)) {
    return `key is not writable: ${key}`;
  }
  const kind = kindOf(key);
  const v = coerce(kind, value);
  if (v === null) {
    return kind === 'bool' ? `${key} must be true or false` : `${key} must be an integer`;
  }
  const bounds = BOUNDS[key];
  if (bounds && (v < bounds[0] || v > bounds[1])) {
    return `${key} must be between ${bounds[0]} and ${bounds[1]}`;
  }
  return null;
}

export function setPolicyValue(db, key, value, actor) {
  db.prepare(
    `INSERT INTO policy (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, String(value), actor);
}

// Diff returned to the agent on a heartbeat: changed keys carry new values, removed keys tell
// the agent to fall back to its own documented default. Unchanged keys are never resent, which
// is what keeps steady-state control traffic at a handful of bytes.
export function diffPolicy(oldPolicy, newPolicy) {
  const changed = {};
  const removed = [];
  for (const key of Object.keys(newPolicy)) {
    if (oldPolicy[key] === undefined) changed[key] = newPolicy[key];
    else if (oldPolicy[key] !== newPolicy[key]) changed[key] = newPolicy[key];
  }
  for (const key of Object.keys(oldPolicy)) {
    if (newPolicy[key] === undefined) removed.push(key);
  }
  return { changed, removed };
}
