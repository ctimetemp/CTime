import { randomUUID, createHash } from 'node:crypto';
import {
  HttpError, readJson, readGzip, conditional, sendJson, sendEmpty,
} from '../httpkit.js';
import {
  validateEnvelope, validateClipboardData, validateExtensionData, validateScreenStateData,
  validateSkippedFrameData, isUuid, isHex64, isIso,
} from '../validate.js';
import { policyDocument, readPolicy, etagOf, diffPolicy } from '../policy.js';
import { hashToken, requireBearer } from '../auth.js';
import { tx } from '../db.js';

const ENROLL_MAX_BYTES = 16 * 1024;
const HEARTBEAT_MAX_BYTES = 4096;
const SINGLE_MAX_BYTES = 8192;
// Compressed bodies are capped by policy; the inflated size needs its own bound or a small
// gzip bomb becomes a large allocation. 4 MiB is far above any legitimate 1000-item batch.
const DECOMPRESSED_MAX_BYTES = 4 * 1024 * 1024;
const CLOCK_SKEW_MS = 10 * 60 * 1000;

export function createDeviceApi({ db, store, audit, notice }) {
  const q = {
    deviceByFingerprint: db.prepare('SELECT * FROM devices WHERE fingerprint = ?'),
    deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
    deviceByToken: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
    insertDevice: db.prepare(`INSERT INTO devices
      (id, fingerprint, hostname, os_build, device_user, lan_ip, agent_version, state,
       enrolled_at, notice_version, acknowledged_at, acknowledged_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', datetime('now'), ?, datetime(?), ?)`),
    touchSeen: db.prepare(`UPDATE devices SET last_seen_at = datetime('now'),
      lan_ip = ?, agent_version = ?, spool_bytes = ?, spool_dropped = ?, bytes_sent = ?, policy_etag = ?
      WHERE id = ?`),
    setTokenHash: db.prepare('UPDATE devices SET token_hash = ? WHERE id = ?'),
    // The three stamps below are what lets the collector answer "is this device actually working"
    // instead of "is this device approved". Approval is an admin's intent; a delivered token, a
    // call home and an accepted row are facts.
    markTokenDelivered: db.prepare(`UPDATE devices SET token_delivered_at = datetime('now')
      WHERE id = ? AND token_delivered_at IS NULL`),
    markFirstContact: db.prepare(`UPDATE devices SET first_contact_at = datetime('now')
      WHERE id = ? AND first_contact_at IS NULL`),
    markFirstData: db.prepare(`UPDATE devices SET first_data_at = datetime('now')
      WHERE id = ? AND first_data_at IS NULL`),
    markFlush: db.prepare(`UPDATE devices SET last_flush_at = datetime('now'), last_flush_ms = ?
      WHERE id = ?`),
    insTraffic: db.prepare(`INSERT INTO device_traffic (device_id, ts, bytes_sent, spool_bytes)
      VALUES (?, datetime('now'), ?, ?)`),
    insClip: db.prepare(`INSERT INTO clipboard_metrics
      (device_id, event_id, sampled_at, char_count, sha256, content_kind)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`),
    insShotMeta: db.prepare(`INSERT INTO screenshots
      (device_id, event_id, captured_at, received_at, bytes, width, height, sha256, phash, storage_key, expires_at)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`),
    insExt: db.prepare(`INSERT INTO extension_inventory
      (device_id, event_id, collected_at, browser, profile, ext_id, name, version, source, permissions, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, browser, profile, ext_id, collected_at) DO NOTHING`),
    insScreenState: db.prepare(`INSERT INTO screen_states (device_id, event_id, sampled_at, state)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`),
    insSkippedFrame: db.prepare(`INSERT INTO screen_states (device_id, event_id, sampled_at, state)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`),
    shotByEvent: db.prepare('SELECT id FROM screenshots WHERE event_id = ?'),
  };

  function resolveDevice(req, ip) {
    const token = requireBearer(req);
    const row = q.deviceByToken.get(hashToken(token));
    if (!row) throw new HttpError(401, 'token_invalid', 'unknown device token');
    // The state check is re-read from the row on every ingest call rather than trusted from the
    // token: revocation has to take effect on the next request, not on the next enrollment.
    if (row.state !== 'approved') throw new HttpError(403, 'state_not_approved', `device is ${row.state}`);
    const { etag } = policyDocument(db);
    if (row.notice_version !== readPolicy(db).notice_version) {
      throw new HttpError(403, 'notice_outdated', 'notice version was bumped; device must re-acknowledge');
    }
    // "The agent called in and the gate let it through" is a fact worth one write, but only the
    // first time -- the guard keeps a 300-heartbeat device from re-issuing the statement.
    if (!row.first_contact_at) q.markFirstContact.run(row.id);
    return { row, ip };
  }

  function requireFields(body, fields, route) {
    const missing = fields.filter((f) => body[f] === undefined);
    if (missing.length) throw new HttpError(400, 'bad_request', `${route}: missing ${missing.join(',')}`);
  }

  return {
    // ---- GET /api/v1/notice -------------------------------------------------------------
    async getNotice(req, res) {
      const version = readPolicy(db).notice_version;
      const body = { version, text: notice.text(), collects: notice.collects() };
      const etag = `"${version}"`;
      res.setHeader('cache-control', 'public, max-age=86400');
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, body, { etag });
    },

    // ---- POST /api/v1/enroll ------------------------------------------------------------
    async enroll(req, res, _params, ip) {
      const body = await readJson(req, ENROLL_MAX_BYTES);
      const { fingerprint, hostname, os_build, device_user, agent_version,
        notice_version, acknowledged_by, acknowledged_at } = body;
      if (!isHex64(String(fingerprint ?? ''))) {
        throw new HttpError(400, 'bad_request', 'fingerprint must be 64 hex chars');
      }
      for (const [name, val, max] of [['hostname', hostname, 200], ['os_build', os_build, 100],
        ['device_user', device_user, 200], ['agent_version', agent_version, 50]]) {
        if (typeof val !== 'string' || val.trim() === '' || val.length > max) {
          throw new HttpError(400, 'bad_request', `${name} must be a non-empty string under ${max} chars`);
        }
      }
      // acknowledged_by is the device user's own typed name. Empty is the failure mode this whole
      // gate exists to prevent, so it is refused here and again by the DB trigger on approval.
      if (typeof acknowledged_by !== 'string' || acknowledged_by.trim() === ''
        || acknowledged_by.length > 200) {
        audit({ actor: `ip:${ip}`, action: 'enroll_rejected_no_ack', target: null,
          detail: 'acknowledged_by empty', ip });
        throw new HttpError(400, 'bad_request', 'acknowledged_by must be the name typed by the device user');
      }
      if (!isIso(acknowledged_at)) {
        throw new HttpError(400, 'bad_request', 'acknowledged_at must be ISO-8601');
      }
      const skew = Math.abs(Date.parse(acknowledged_at) - Date.now());
      if (skew > CLOCK_SKEW_MS) {
        // Without this the agent could ship a fabricated "agreed in 2020" timestamp that the
        // schema would happily accept as a consent record.
        throw new HttpError(400, 'bad_request', 'clock_skew');
      }
      if (typeof notice_version !== 'string' || notice_version.trim() === '') {
        throw new HttpError(400, 'bad_request', 'notice_version is required');
      }
      const current = readPolicy(db).notice_version;
      if (notice_version !== current) {
        throw new HttpError(403, 'notice_outdated', `server notice is ${current}`);
      }

      const existing = q.deviceByFingerprint.get(fingerprint);
      if (existing) {
        // Re-enrollment is idempotent. Consent fields are refreshed because the user re-acknowledged.
        if (existing.state !== 'revoked') {
          db.prepare(`UPDATE devices SET hostname=?, os_build=?, device_user=?, agent_version=?,
            acknowledged_by=?, acknowledged_at=datetime(?), notice_version=? WHERE id=?`)
            .run(hostname, os_build, device_user, agent_version, acknowledged_by.trim(),
              acknowledged_at, notice_version, existing.id);
        }
        audit({ actor: `device:${existing.id}`, action: 'enroll_repeat', target: existing.hostname,
          detail: `state=${existing.state}`, ip });
        sendJson(res, 202, { device_id: existing.id, state: existing.state });
        return;
      }
      const id = randomUUID();
      q.insertDevice.run(id, fingerprint, hostname, os_build, device_user, ip, agent_version,
        notice_version, acknowledged_at, acknowledged_by.trim());
      audit({ actor: `device:${id}`, action: 'enroll', target: hostname,
        detail: `notice ${notice_version} acknowledged by supplied name`, ip });
      sendJson(res, 202, { device_id: id, state: 'pending_approval' });
    },

    // ---- GET /api/v1/enroll/status ------------------------------------------------------
    async enrollStatus(req, res, ip) {
      const url = new URL(req.url, 'http://x');
      const fingerprint = url.searchParams.get('fingerprint') ?? '';
      if (!isHex64(fingerprint)) throw new HttpError(400, 'bad_request', 'fingerprint must be 64 hex chars');
      const row = q.deviceByFingerprint.get(fingerprint);
      if (!row) throw new HttpError(404, 'unknown_device', 'not enrolled');
      const { etag } = policyDocument(db);
      const body = { state: row.state, policy_etag: etag };
      if (row.state === 'approved' && !row.token_hash) {
        // Delivered exactly once. The plaintext exists only in this response and, moments later,
        // inside the agent's DPAPI blob.
        const token = randomUUID().replace(/-/g, '') + createHash('sha256')
          .update(`${row.id}|${Date.now()}`).digest('hex').slice(0, 32);
        q.setTokenHash.run(hashToken(token), row.id);
        q.markTokenDelivered.run(row.id);
        body.token = token;
        audit({ actor: `device:${row.id}`, action: 'token_issued', target: row.hostname, detail: null, ip });
      }
      sendJson(res, 200, body);
    },

    // ---- GET /api/v1/config -------------------------------------------------------------
    async getConfig(req, res) {
      resolveDevice(req);
      const { policy, etag } = policyDocument(db);
      // Record the document that this etag stands for. A heartbeat that later reports this etag is
      // answered with a delta, and the delta can only be computed against a stored snapshot.
      // Without this line the first delta an agent ever receives is the whole document.
      rememberSnapshot(db, etag, policy);
      res.setHeader('x-policy-etag', etag);
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, policy, { etag });
    },

    // ---- POST /api/v1/heartbeat ---------------------------------------------------------
    async heartbeat(req, res, _p, ip) {
      const { row } = resolveDevice(req, ip);
      const body = await readJson(req, HEARTBEAT_MAX_BYTES);
      requireFields(body, ['policy_etag', 'spool_bytes', 'spool_dropped', 'bytes_sent'], 'heartbeat');
      const policy = readPolicy(db);
      const currentEtag = etagOf(policy);
      q.touchSeen.run(ip, body.agent_version ?? row.agent_version, Number(body.spool_bytes) || 0,
        Number(body.spool_dropped) || 0, Number(body.bytes_sent) || 0,
        String(body.policy_etag ?? ''), row.id);
      q.insTraffic.run(row.id, Number(body.bytes_sent) || 0, Number(body.spool_bytes) || 0);

      if (body.policy_etag === currentEtag) {
        // 204 with a zero-length body is the steady state. perf-bench asserts the byte count.
        sendEmpty(res, 204);
        return;
      }
      // The agent only reports which etag it holds, so the server keeps a snapshot per etag and
      // diffs against the document the agent actually has. No snapshot (fresh agent, or a policy
      // history entry that aged out) means the agent is unknown to us, so send everything.
      const base = snapshotFor(db, String(body.policy_etag ?? '')) ?? {};
      const { changed, removed } = diffPolicy(base, policy);
      rememberSnapshot(db, currentEtag, policy);
      sendJson(res, 200, { changed, removed }, { 'x-policy-etag': currentEtag });
    },

    // ---- POST /api/v1/batch -------------------------------------------------------------
    async batch(req, res, _p, ip) {
      const startedNs = process.hrtime.bigint();
      const { row } = resolveDevice(req, ip);
      const policy = readPolicy(db);
      if ((req.headers['content-encoding'] ?? '').toLowerCase() !== 'gzip') {
        throw new HttpError(415, 'unsupported_media', 'Content-Encoding: gzip required');
      }
      const raw = await readGzip(req, DECOMPRESSED_MAX_BYTES);
      const lines = raw.toString('utf8').split('\n').filter((l) => l.trim() !== '');
      if (lines.length > policy.batch_max_items * 4) {
        // Hard ceiling well above the batch size; stops one oversized flush from pinning the loop.
        throw new HttpError(413, 'body_too_large', 'too many lines in one batch');
      }

      // Pass 1 validates before anything is written. The content-field rule rejects the WHOLE
      // batch, so a partial write before discovering the bad line would already have leaked data
      // in through the good lines.
      const parsed = [];
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { parsed.push({ malformed: true }); continue; }
        const env = validateEnvelope(obj);
        if (!env.ok) { parsed.push({ malformed: true }); continue; }
        parsed.push({ env: env.event });
      }
      for (const p of parsed) {
        if (p.malformed) continue;
        if (p.env.type === 'clipboard_metric') {
          const v = validateClipboardData(p.env.data);
          if (!v.ok && v.forbiddenKey) {
            // Key name only, never the value. The detail column must not become the leak.
            audit({ actor: `device:${row.id}`, action: 'clipboard_content_rejected',
              target: p.env.event_id, detail: `forbidden key: ${v.forbiddenKey}`, ip });
            throw new HttpError(422, 'content_field_forbidden',
              `batch rejected: clipboard payload carried "${v.forbiddenKey}"`);
          }
        }
      }

      // Pass 2 writes inside one transaction. 200 events -> one fsync.
      const counts = { accepted: 0, duplicates: 0, malformed: 0, unknown_types: 0 };
      const extStmts = [];
      tx(db, () => {
        for (const p of parsed) {
          if (p.malformed) { counts.malformed += 1; continue; }
          const e = p.env;
          switch (e.type) {
            case 'clipboard_metric': {
              const v = validateClipboardData(e.data);
              if (!v.ok) { counts.malformed += 1; break; }
              const r = q.insClip.run(row.id, e.event_id, v.value.sampled_at, v.value.char_count,
                v.value.sha256, v.value.content_kind);
              counts[r.changes ? 'accepted' : 'duplicates'] += 1;
              break;
            }
            case 'extension_inventory': {
              const v = validateExtensionData(e.data);
              if (!v.ok) { counts.malformed += 1; break; }
              let any = 0;
              for (const ext of v.value.extensions) {
                const r = q.insExt.run(row.id, e.event_id, v.value.collected_at, v.value.browser,
                  v.value.profile, ext.ext_id, ext.name, ext.version, ext.source,
                  JSON.stringify(ext.permissions), ext.enabled);
                any += r.changes;
              }
              // An event with zero new rows is still a delivery the server has now seen; counting
              // it accepted keeps accepted+duplicates+malformed+unknown == lines.
              counts[any ? 'accepted' : 'duplicates'] += 1;
              extStmts.push(v.value.extensions.length);
              break;
            }
            case 'screen_state': {
              const v = validateScreenStateData(e.data);
              if (!v.ok) { counts.malformed += 1; break; }
              const r = q.insScreenState.run(row.id, e.event_id, v.value.sampled_at, v.value.state);
              counts[r.changes ? 'accepted' : 'duplicates'] += 1;
              break;
            }
            case 'screenshot_skipped_unchanged': {
              const v = validateSkippedFrameData(e.data);
              if (!v.ok) { counts.malformed += 1; break; }
              // Stored as a screen_state sentinel so the wall can render "no change" as an
              // intentional gap instead of a missing capture.
              const r = q.insSkippedFrame.run(row.id, e.event_id, v.value.captured_at,
                `unchanged:${v.value.phash ?? v.value.sha256.slice(0, 16)}`);
              counts[r.changes ? 'accepted' : 'duplicates'] += 1;
              break;
            }
            default:
              counts.unknown_types += 1;
          }
        }
        // Statement carries `AND first_data_at IS NULL`, so this is a no-op from the second batch
        // on. Being inside the transaction means the stamp and the rows it stands for land
        // together or not at all.
        if (counts.accepted > 0) q.markFirstData.run(row.id);
      });
      const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      q.markFlush.run(Math.round(elapsedMs * 10) / 10, row.id);
      sendJson(res, 200, counts);
    },

    // ---- POST /api/v1/screenshots -------------------------------------------------------
    async screenshot(req, res, _p, ip) {
      const { row } = resolveDevice(req, ip);
      const policy = readPolicy(db);
      const contentType = (req.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/png') && !contentType.startsWith('image/png')) {
        throw new HttpError(415, 'unsupported_media', 'Content-Type must be application/png');
      }
      const eventId = req.headers['x-event-id'];
      const capturedAt = req.headers['x-captured-at'];
      const shaHeader = req.headers['x-sha256'];
      const phash = typeof req.headers['x-phash'] === 'string' ? req.headers['x-phash'].slice(0, 64) : null;
      if (!isUuid(String(eventId ?? ''))) throw new HttpError(400, 'bad_request', 'X-Event-Id must be a UUID');
      if (!isIso(String(capturedAt ?? ''))) throw new HttpError(400, 'bad_request', 'X-Captured-At must be ISO-8601');
      if (shaHeader !== undefined && !isHex64(String(shaHeader))) {
        throw new HttpError(400, 'bad_request', 'X-Sha256 must be 64 hex chars');
      }
      const declaredDevice = req.headers['x-device-id'];
      if (declaredDevice !== undefined && declaredDevice !== row.id) {
        throw new HttpError(401, 'token_mismatch', 'X-Device-Id does not match the token');
      }

      const existing = q.shotByEvent.get(eventId);
      if (existing) {
        // Drain without storing so a retry after a lost response is a clean no-op.
        await discard(req);
        sendJson(res, 200, { id: existing.id, duplicate: true });
        return;
      }

      const stored = await store.put(req, {
        deviceId: row.id, eventId, maxSize: policy.screenshot_max_bytes,
        expectSha256: shaHeader ? String(shaHeader).toLowerCase() : null,
      });
      const expires = new Date(Date.now() + policy.screenshot_retention_days * 86400000).toISOString();
      let id;
      tx(db, () => {
        const r = q.insShotMeta.run(row.id, eventId, capturedAt, stored.bytes, stored.width,
          stored.height, stored.sha256, phash, stored.storageKey, expires);
        if (r.changes) { id = Number(r.lastInsertRowid); }
      });
      if (id === undefined) {
        // Another request won the race on this event_id; keep its file and drop ours.
        store.remove(stored.storageKey);
        const again = q.shotByEvent.get(eventId);
        sendJson(res, 200, { id: again?.id, duplicate: true });
        return;
      }
      q.markFirstData.run(row.id);
      audit({ actor: `device:${row.id}`, action: 'screenshot_ingest', target: eventId,
        detail: `${stored.bytes} bytes`, ip });
      sendJson(res, 201, { id });
    },

    // ---- POST /api/v1/clipboard-metric --------------------------------------------------
    async clipboardMetric(req, res, _p, ip) {
      const { row } = resolveDevice(req, ip);
      const body = await readJson(req, SINGLE_MAX_BYTES);
      const v = validateClipboardData(body);
      if (!v.ok) {
        if (v.forbiddenKey) {
          audit({ actor: `device:${row.id}`, action: 'clipboard_content_rejected', target: null,
            detail: `forbidden key: ${v.forbiddenKey}`, ip });
          throw new HttpError(422, 'content_field_forbidden',
            `clipboard payload may not carry "${v.forbiddenKey}"`);
        }
        throw new HttpError(400, 'bad_request', v.reason);
      }
      const eventId = req.headers['x-event-id'] ?? randomUUID();
      if (!isUuid(String(eventId))) throw new HttpError(400, 'bad_request', 'X-Event-Id must be a UUID');
      const r = q.insClip.run(row.id, eventId, v.value.sampled_at, v.value.char_count,
        v.value.sha256, v.value.content_kind);
      if (r.changes) q.markFirstData.run(row.id);
      sendJson(res, r.changes ? 201 : 200, { accepted: r.changes ? 1 : 0, duplicate: !r.changes,
        event_id: eventId });
    },
  };
}

function discard(req) {
  return new Promise((resolveP) => {
    req.resume();
    req.on('end', resolveP);
    req.on('error', resolveP);
  });
}

// One row per policy revision the collector has served. Bounded: the newest `keep` etags are
// retained, older ones age out, so a long-lived collector cannot accumulate a snapshot per
// dashboard edit forever. A device whose snapshot aged out gets the full document once.
const SNAPSHOT_KEEP = 32;

function snapshotFor(db, etag) {
  if (!etag) return null;
  const row = db.prepare('SELECT doc FROM policy_snapshots WHERE etag = ?').get(etag);
  if (!row) return null;
  try { return JSON.parse(row.doc); } catch { return null; }
}

function rememberSnapshot(db, etag, policy) {
  db.prepare(`INSERT INTO policy_snapshots (etag, doc, created_at)
    VALUES (?, ?, datetime('now')) ON CONFLICT(etag) DO NOTHING`).run(etag, JSON.stringify(policy));
  db.prepare(`DELETE FROM policy_snapshots WHERE etag NOT IN
    (SELECT etag FROM policy_snapshots ORDER BY created_at DESC, etag DESC LIMIT ?)`)
    .run(SNAPSHOT_KEEP);
}
