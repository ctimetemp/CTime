import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HttpError, isRetryable } from './errors.js';
import { phashFromPng, isUnchanged } from './phash.js';
import { readExtensionInventory, fileGist } from './extensions.js';

const MAX_LINE_BYTES = 8192;

// Envelope builder. Every event the agent produces has exactly these fields; a producer that
// invents a field is caught by the server's validators, not quietly tolerated here.
export function envelope({ type, deviceId, data, ts }) {
  return { event_id: randomUUID(), type, device_id: deviceId, ts: ts ?? new Date().toISOString(), data };
}

// Full-jitter exponential backoff. Full jitter (rather than equal jitter) is what keeps fifty
// devices that lost the collector simultaneously from stampeding back on the same schedule.
//
// The defaults are the agent's reconnect policy, not a generic helper: base 2s, ceiling 2min. An
// outage costs the dashboard nothing because the spool holds everything, but a device whose link
// came back thirty seconds ago should not sit silent for fifteen minutes before it says so -- and
// the connection watch wakes it even earlier than this ceiling.
export function backoffDelay(attempt, baseMs = 2000, capMs = 120000, rand = Math.random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.floor(rand() * ceiling);
}

export function createProducers({ spool, policy, deviceId, capture, sampleClipboard, log }) {
  let lastFramePhash = null;
  let lastFrameSha = null;
  let lastCaptureReason = null;
  let extGistFile = null;
  let lastInventoryAt = 0;
  let seenGists = new Map();

  function loadGists(stateDir) {
    extGistFile = path.join(stateDir, 'extension-gists.json');
    if (!existsSync(extGistFile)) return;
    try {
      const raw = JSON.parse(readFileSync(extGistFile, 'utf8'));
      seenGists = new Map(Object.entries(raw));
      lastInventoryAt = Number(raw.__at ?? 0);
    } catch { /* re-crawl */ }
  }

  function saveGists() {
    if (!extGistFile) return;
    const obj = Object.fromEntries(seenGists);
    obj.__at = lastInventoryAt;
    try { writeFileSync(extGistFile, JSON.stringify(obj)); } catch { /* non-fatal */ }
  }

  // Screenshot tick. Note the ordering: the lock/idle check happens BEFORE capture (zero pixels
  // for an unattended machine) and the perceptual comparison happens AFTER capture but BEFORE the
  // spool write (an unchanged screen never becomes an uploadable blob).
  async function screenshotTick() {
    const values = policy.values;
    if (!values.screenshot_interval_minutes) return { skipped: 'policy' };
    const { state, captured, png, reason, idleSeconds } = await capture({
      idleSkipSeconds: values.idle_skip_seconds,
      skipWhenLocked: values.skip_when_locked,
    });
    const ts = new Date().toISOString();
    if (!captured) {
      // A capture that could not happen is stated in the log, once per distinct reason. Screen
      // states say only 'active', so without this an agent running in a session that cannot grant a
      // screen handle looks perfectly healthy on the dashboard while producing no frames at all.
      if (reason && reason !== lastCaptureReason) {
        log(`capture unavailable: ${reason}`);
        lastCaptureReason = reason;
      }
      spool.append(envelope({ type: 'screen_state', deviceId: deviceId(), ts,
        data: { sampled_at: ts, state: reason ? 'active' : state } }));
      return { skipped: state, reason };
    }
    const phash = phashFromPng(png);
    const sha = sha256Hex(png);
    if (values.dedupe_unchanged_frames && phash && lastFramePhash && isUnchanged(lastFramePhash, phash)) {
      // Upload nothing, but record the decision so the dashboard shows an intentional gap rather
      // than a hole. lastFrame* is NOT advanced: the accepted frame remains the reference.
      spool.append(envelope({ type: 'screenshot_skipped_unchanged', deviceId: deviceId(), ts,
        data: { captured_at: ts, sha256: lastFrameSha ?? sha, phash } }));
      return { skipped: 'unchanged', phash };
    }
    if (png.length > values.screenshot_max_bytes) {
      log(`capture ${png.length}b exceeds screenshot_max_bytes; recording as oversized`);
      spool.append(envelope({ type: 'screen_state', deviceId: deviceId(), ts,
        data: { sampled_at: ts, state: 'active' } }));
      return { skipped: 'oversized' };
    }
    // The blob name carries the event id alone; writeBlob adds the .png. Passing "uuid.png" here
    // used to produce "uuid.png.png", which eventIdFromBlob could not turn back into a UUID, so
    // every upload was rejected by the server as a bad X-Event-Id.
    const blob = spool.writeBlob(randomUUID(), png);
    lastFramePhash = phash;
    lastFrameSha = sha;
    return { captured: true, blob, bytes: png.length, width: undefined, idleSeconds };
  }

  async function clipboardTick() {
    const values = policy.values;
    if (values.clipboard_metrics_enabled === false) return { skipped: 'policy' };
    const sample = await sampleClipboard();
    if (!sample) return { skipped: 'probe' };
    const ts = new Date().toISOString();
    spool.append(envelope({ type: 'clipboard_metric', deviceId: deviceId(), ts,
      data: { sampled_at: ts, ...sample } }));
    return { appended: true, kind: sample.content_kind };
  }

  // Extension tick. The gate is the source file's mtime+size+sha256, so an unchanged profile
  // costs a stat and a hash instead of a parse-and-upload; and a profile that changed is still
  // only re-uploaded once per ext_inventory_max_age_hours.
  async function extensionTick({ force = false } = {}) {
    const values = policy.values;
    if (values.extension_inventory_enabled === false) return { skipped: 'policy' };
    const maxAgeMs = (values.ext_inventory_max_age_hours ?? 24) * 3600 * 1000;
    const ageOk = Date.now() - lastInventoryAt >= maxAgeMs;
    if (!force && !ageOk) return { skipped: 'not_due' };
    const found = readExtensionInventory();
    const ts = new Date().toISOString();
    let uploaded = 0;
    for (const entry of found) {
      const key = `${entry.browser}|${entry.profile}`;
      if (!force && seenGists.get(key) === entry.gist && ageOk === false) continue;
      if (!force && seenGists.get(key) === entry.gist) continue;
      const event = envelope({ type: 'extension_inventory', deviceId: deviceId(), ts,
        data: {
          collected_at: ts, browser: entry.browser, profile: entry.profile,
          extensions: entry.extensions,
        } });
      spool.append(event);
      seenGists.set(key, entry.gist);
      uploaded += 1;
    }
    if (uploaded > 0 || force) lastInventoryAt = Date.now();
    saveGists();
    return { uploaded };
  }

  return {
    screenshotTick, clipboardTick, extensionTick,
    loadGists,
    lastFrame: () => ({ phash: lastFramePhash, sha: lastFrameSha }),
    // A capture-due flush counts the blob itself; the blob's bytes are added to the estimate of
    // when the batch budget is met.
    pendingBlobBytes() {
      return spool.pendingBlobFiles().reduce((n, f) => {
        try { return n + statSize(f); } catch { return n; }
      }, 0);
    },
  };
}

function statSize(file) {
  return statSync(file).size;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export { MAX_LINE_BYTES };
