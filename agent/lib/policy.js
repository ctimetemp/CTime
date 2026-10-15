import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// These defaults exist for exactly one situation: a policy key is absent from the server document
// or has been listed in a `removed` diff. The agent never picks an interval, threshold or flag on
// its own when the server has one, and any change here must be mirrored in API-CONTRACT.md.
export const AGENT_DEFAULTS = {
  screenshot_interval_minutes: 5,
  screenshot_retention_days: 30,
  screenshot_max_bytes: 8388608,
  clipboard_metrics_enabled: true,
  extension_inventory_enabled: true,
  clipboard_sample_seconds: 60,
  heartbeat_interval_seconds: 300,
  batch_max_items: 200,
  batch_max_bytes: 262144,
  batch_max_age_seconds: 120,
  spool_max_bytes: 134217728,
  skip_when_locked: true,
  idle_skip_seconds: 600,
  dedupe_unchanged_frames: true,
  ext_inventory_max_age_hours: 24,
};

const BOOL_KEYS = ['clipboard_metrics_enabled', 'extension_inventory_enabled',
  'skip_when_locked', 'dedupe_unchanged_frames'];

export function createPolicyState({ file, onWarn = () => {} }) {
  let state = { etag: null, values: { ...AGENT_DEFAULTS } };
  if (existsSync(file)) {
    try { state = { etag: null, values: { ...AGENT_DEFAULTS }, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* start clean */ }
  }
  // An etag held in memory but absent on disk means the collector would keep sending a full
  // document on every heartbeat; persist it so the steady state stays a 204.
  const save = () => {
    try { writeFileSync(file, JSON.stringify(state, null, 2)); } catch (err) { onWarn(`policy save: ${err.message}`); }
  };
  return {
    get etag() { return state.etag; },
    get values() { return { ...state.values }; },
    // Full document from GET /config: replace wholesale, so a key the server dropped falls back
    // to the documented default instead of persisting as a stale local value.
    replace(doc, etag) {
      const values = { ...AGENT_DEFAULTS };
      // Only recognised keys are adopted. An unknown key from a newer server is ignored rather
      // than persisted, so it cannot linger here after the server stops sending it.
      for (const [k, v] of Object.entries(doc ?? {})) {
        if (k in AGENT_DEFAULTS) values[k] = normalise(k, v);
      }
      state = { etag, values };
      save();
      return state.values;
    },
    // Heartbeat delta: changed keys are applied, removed keys fall back to the default. Unknown
    // keys in the delta are ignored, which is what lets a newer server talk to an older agent.
    applyDiff({ changed = {}, removed = [] }, etag) {
      for (const [k, v] of Object.entries(changed)) {
        if (k in AGENT_DEFAULTS) state.values[k] = normalise(k, v);
      }
      for (const k of removed) {
        if (k in AGENT_DEFAULTS) state.values[k] = AGENT_DEFAULTS[k];
      }
      if (etag) state.etag = etag;
      save();
      return state.values;
    },
    setEtag(etag) { state.etag = etag; save(); },
    // The human-readable config the device user can open. Batching policy is included so
    // "how often does data leave this machine" is answerable without reading source.
    describe() {
      return {
        ...state.values,
        _note: 'All intervals, thresholds and flags are set by the collector server. Values here are what this device is currently running.',
      };
    },
  };
}

function normalise(key, value) {
  if (BOOL_KEYS.includes(key)) return value === true || value === 'true';
  if (key === 'notice_version') return String(value ?? '');
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}
