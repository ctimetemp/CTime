import { createReadStream, statSync, unlinkSync, existsSync } from 'node:fs';
import { HttpError, isRetryable } from './errors.js';
import { backoffDelay } from './producers.js';

// The flush loop is the only thing in the agent that touches the network. Producers write to the
// spool and return; if the collector is down, the device notices nothing except a growing spool.
export function createFlusher({ transport, spool, policy, deviceId, token, log, onPolicy }) {
  let bytesSent = 0;
  let attempt = { heartbeat: 0, batch: 0, shot: 0 };
  let lastError = null;
  // What this process has actually handed to the collector. The device user's daily notice quotes
  // these numbers, so they are counted where the bytes are counted rather than guessed later.
  const counts = { events: 0, screenshots: 0, batches: 0 };

  function noteSuccess(kind) { attempt[kind] = 0; }

  async function withBackoff(kind, work) {
    try {
      const out = await work();
      noteSuccess(kind);
      return out;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) {
        // A terminal code (422 content rejection, 401 bad token, pin mismatch) must not be retried
        // at all: retrying would re-send the payload that was refused.
        log(`${kind} terminal: ${err.code} ${err.detail ?? ''}`);
        return { terminal: err };
      }
      // Base 2s, ceiling 2min -- the defaults in backoffDelay are the agent's reconnect policy, kept
      // in one place so the ceiling a device sleeps under is the same number the tests assert.
      const delay = err.retryAfter
        ? Math.min(err.retryAfter * 1000, 300000)
        : backoffDelay(attempt[kind]++);
      log(`${kind} retryable: ${err.code ?? err.message}; backing off ${Math.round(delay / 1000)}s`);
      return { retryInMs: delay };
    }
  }

  // Heartbeat carries the policy etag the agent is running plus spool health. 204 means the
  // configuration is unchanged and the response body was zero bytes; that is the steady state.
  async function heartbeat() {
    const values = policy.values;
    const totals = spool.totals();
    const res = await withBackoff('heartbeat', async () => {
      const r = await transport.postJson('/api/v1/heartbeat', {
        policy_etag: policy.etag,
        spool_bytes: totals.bytes,
        spool_dropped: spool.dropped(),
        bytes_sent: bytesSent,
      }, token.headers());
      if (r.status === 204) {
        return { unchanged: true };
      }
      const body = JSON.parse(r.body.toString('utf8'));
      const applied = policy.applyDiff(body, r.headers['x-policy-etag'] ?? policy.etag);
      if (body.changed || body.removed) onPolicy?.(applied, body);
      return { changed: body };
    });
    return res;
  }

  // Chunks until the spool is drained or a budget-bound request has been accepted, so the
  // post-approval backfill can never become one enormous request.
  async function flushBatch() {
    const values = policy.values;
    const sent = [];
    for (let guard = 0; guard < 200; guard++) {
      const { events, files } = spool.takeBatch(values.batch_max_items, values.batch_max_bytes);
      if (events.length === 0) return { drained: true, sent };
      const res = await withBackoff('batch', async () => {
        const r = await transport.postGzipNdjson('/api/v1/batch', events, {
          ...token.headers(), 'x-device-id': deviceId(),
        });
        return JSON.parse(r.body.toString('utf8'));
      });
      if (res.terminal) {
        const code = res.terminal.code;
        if (code === 'content_field_forbidden') {
          // The server refused the whole segment. Dropping it is the only correct response:
          // keeping it would re-offer clipboard content on every retry.
          spool.discardFiles(files);
          spool.markDropped(events.length);
          log(`dropped ${events.length} events after content rejection`);
        }
        return { stopped: code, sent };
      }
      if (res.retryInMs !== undefined) return { retryInMs: res.retryInMs, sent };
      bytesSent += estimateCompressed(events);
      counts.events += events.length;
      counts.batches += 1;
      // Accepted or duplicate, the server has the events either way; at-least-once plus
      // event_id uniqueness means the segment can go.
      spool.discardFiles(files);
      sent.push(res);
      if (events.length < values.batch_max_items) return { drained: true, sent };
    }
    return { hitGuard: true, sent };
  }

  // Screenshots go out one at a time as streamed bodies, oldest first, each independently
  // idempotent on its event id.
  async function flushScreenshots() {
    const values = policy.values;
    const files = spool.pendingBlobFiles();
    if (files.length === 0) return { uploaded: 0 };
    let uploaded = 0;
    for (const file of files) {
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.size > values.screenshot_max_bytes) {
        log(`blob ${st.size}b over cap; dropping`);
        unlinkSync(file);
        spool.markDropped(1);
        continue;
      }
      const capturedAt = new Date(st.mtimeMs).toISOString();
      const eventId = eventIdFromBlob(file);
      const res = await withBackoff('shot', async () => {
        const r = await transport.postPng('/api/v1/screenshots', file, {
          ...token.headers(),
          'x-event-id': eventId,
          'x-device-id': deviceId(),
          'x-captured-at': capturedAt,
        });
        return { status: r.status, body: JSON.parse(r.body.toString('utf8')) };
      });
      if (res.terminal || res.retryInMs !== undefined) return { uploaded, stopped: res.terminal?.code ?? 'backoff' };
      bytesSent += st.size;
      counts.screenshots += 1;
      if (existsSync(file)) unlinkSync(file);
      uploaded += 1;
    }
    return { uploaded };
  }

  async function cycle() {
    const hb = await heartbeat();
    const batch = await flushBatch();
    const shots = await flushScreenshots();
    return { hb, batch, shots, lastError };
  }

  return {
    cycle, heartbeat, flushBatch, flushScreenshots,
    bytesSent: () => bytesSent,
    counts: () => ({ ...counts }),
    addBytes: (n) => { bytesSent += n; },
    state: () => ({ attempt, lastError: lastError ? { code: lastError.code, detail: lastError.detail } : null }),
  };
}

// The blob name is `<time36>-<uuid>.png`; the event id is recovered from it rather than kept in a
// sidecar, so a crash between writing and flushing cannot orphan an unattributable image.
function eventIdFromBlob(file) {
  const base = file.split(/[\\/]/).pop().replace(/\.png$/, '');
  const m = /^[0-9a-z]+-([0-9a-f-]{36})$/i.exec(base);
  return m ? m[1] : base;
}

function estimateCompressed(events) {
  // gzip ratio on NDJSON is high and variable; an order-of-magnitude estimate is enough for a
  // traffic gauge, and the real number is bounded by what the server counted.
  const raw = events.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
  return Math.round(raw / 4);
}
