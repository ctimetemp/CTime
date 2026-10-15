// Clipboard payload validation. This module is the single implementation used by BOTH
// POST /api/v1/clipboard-metric and every clipboard_metric line inside POST /api/v1/batch.
// Two code paths that validate separately drift, and batching is where a future contributor
// could most easily smuggle clipboard text through.

// Names chosen to cover the ways "the text" plausibly gets added later: a contributor widening
// the contract would reach for one of these. Matching is case-insensitive and substring-free --
// exact key names, so a legitimate field is never caught by accident.
export const FORBIDDEN_CLIPBOARD_KEYS = [
  'content', 'text', 'value', 'raw', 'data', 'payload', 'body', 'snippet', 'preview',
  'clipboard', 'string', 'contents',
];

const ALLOWED_CLIPBOARD_KEYS = ['sampled_at', 'char_count', 'sha256', 'content_kind'];
const CONTENT_KINDS = ['text', 'file-list', 'empty', 'image'];

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isUuid(s) { return typeof s === 'string' && UUID.test(s.toLowerCase()); }
export function isHex64(s) { return typeof s === 'string' && HEX64.test(s); }
export function isIso(s) { return typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s)); }

export function findForbiddenClipboardKey(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_CLIPBOARD_KEYS.includes(lower)) return key;
  }
  return null;
}

// Returns {ok:true, value} or {ok:false, forbiddenKey, reason}.
// forbiddenKey is set ONLY for the content-field violation, because that is the one the caller
// must escalate to a whole-batch rejection plus an audit row. Ordinary schema failures are
// per-line problems and stay recoverable.
export function validateClipboardData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'data must be an object' };
  }
  const forbiddenKey = findForbiddenClipboardKey(data);
  if (forbiddenKey !== null) {
    return { ok: false, forbiddenKey, reason: `clipboard payload may not carry a ${forbiddenKey} field` };
  }
  const extra = Object.keys(data).filter((k) => !ALLOWED_CLIPBOARD_KEYS.includes(k));
  if (extra.length > 0) return { ok: false, reason: `unexpected keys: ${extra.join(',')}` };
  const missing = ALLOWED_CLIPBOARD_KEYS.filter((k) => data[k] === undefined || data[k] === null);
  // content_kind may legitimately be absent for an old agent; the other three are mandatory.
  const required = ['sampled_at', 'char_count', 'sha256'];
  const hardMissing = missing.filter((k) => required.includes(k));
  if (hardMissing.length > 0) return { ok: false, reason: `missing keys: ${hardMissing.join(',')}` };
  if (!isIso(data.sampled_at)) return { ok: false, reason: 'sampled_at must be ISO-8601' };
  if (!Number.isInteger(data.char_count) || data.char_count < 0 || data.char_count > 1_000_000) {
    return { ok: false, reason: 'char_count must be a non-negative integer' };
  }
  if (!isHex64(data.sha256)) return { ok: false, reason: 'sha256 must be 64 hex chars' };
  if (data.content_kind !== undefined && !CONTENT_KINDS.includes(data.content_kind)) {
    return { ok: false, reason: 'content_kind must be one of ' + CONTENT_KINDS.join('|') };
  }
  return {
    ok: true,
    value: {
      sampled_at: data.sampled_at,
      char_count: data.char_count,
      sha256: data.sha256.toLowerCase(),
      content_kind: data.content_kind ?? null,
    },
  };
}

const EXT_BROWSERS = ['chrome', 'brave', 'edge', 'firefox'];
const EXT_SOURCES = ['webstore', 'local', 'sideload', 'builtin', 'unknown'];

function cleanString(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

export function validateEnvelope(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not an object' };
  if (!isUuid(obj.event_id)) return { ok: false, reason: 'event_id must be a UUID' };
  if (typeof obj.type !== 'string' || obj.type.length === 0 || obj.type.length > 64) {
    return { ok: false, reason: 'type must be a short string' };
  }
  if (!isUuid(obj.device_id)) return { ok: false, reason: 'device_id must be a UUID' };
  if (!isIso(obj.ts)) return { ok: false, reason: 'ts must be ISO-8601' };
  if (obj.data === undefined) return { ok: false, reason: 'data is required' };
  return { ok: true, event: obj };
}

export function validateExtensionData(data) {
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'data must be an object' };
  if (!isIso(data.collected_at)) return { ok: false, reason: 'collected_at must be ISO-8601' };
  if (!EXT_BROWSERS.includes(data.browser)) return { ok: false, reason: 'unknown browser' };
  const profile = cleanString(data.profile, 128);
  if (!profile) return { ok: false, reason: 'profile is required' };
  if (!Array.isArray(data.extensions)) return { ok: false, reason: 'extensions must be an array' };
  if (data.extensions.length > 512) return { ok: false, reason: 'more than 512 extensions in one event' };
  const rows = [];
  for (const raw of data.extensions) {
    if (raw === null || typeof raw !== 'object') continue;
    const extId = cleanString(raw.ext_id, 256);
    if (!extId) continue;
    const perms = Array.isArray(raw.permissions)
      ? raw.permissions.slice(0, 64).map((p) => cleanString(p, 256)).filter(Boolean)
      : [];
    rows.push({
      ext_id: extId,
      name: cleanString(raw.name, 512),
      version: cleanString(raw.version, 128),
      // An unexpected source label is stored as unknown rather than rejected: extension source
      // is descriptive, and dropping an inventory row over a label is worse than labelling it.
      source: EXT_SOURCES.includes(raw.source) ? raw.source : 'unknown',
      permissions: perms,
      enabled: raw.enabled === false ? 0 : 1,
    });
  }
  return {
    ok: true,
    value: { collected_at: data.collected_at, browser: data.browser, profile, extensions: rows },
  };
}

export function validateScreenStateData(data) {
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'data must be an object' };
  if (!isIso(data.sampled_at)) return { ok: false, reason: 'sampled_at must be ISO-8601' };
  if (!['locked', 'idle', 'active'].includes(data.state)) return { ok: false, reason: 'bad state' };
  return { ok: true, value: { sampled_at: data.sampled_at, state: data.state } };
}

export function validateSkippedFrameData(data) {
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'data must be an object' };
  if (!isIso(data.captured_at)) return { ok: false, reason: 'captured_at must be ISO-8601' };
  if (!isHex64(data.sha256)) return { ok: false, reason: 'sha256 must be 64 hex chars' };
  const phash = cleanString(data.phash, 64);
  return { ok: true, value: { captured_at: data.captured_at, sha256: data.sha256.toLowerCase(), phash } };
}

export { CONTENT_KINDS, EXT_BROWSERS };
