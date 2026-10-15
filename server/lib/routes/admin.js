import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  HttpError, readJson, sendJson, conditional, etagOfBuffer, clientIp, pageParams,
} from '../httpkit.js';
import { pagedQuery } from '../db.js';
import { healthRows, DEVICE_COLS as deviceCols, makeVerifier } from '../queries.js';
import {
  policyDocument, readPolicy, validatePolicyWrite, setPolicyValue, ADMIN_WRITABLE_KEYS, AGENT_POLICY_KEYS,
} from '../policy.js';
import { hashPassword, verifyPassword, csrfFor, requireCsrf } from '../auth.js';
import { isUuid } from '../validate.js';

const ADMIN_BODY_MAX = 256 * 1024;

function isoNow() { return new Date().toISOString(); }

export function createAdminApi(ctx) {
  const { db, store, audit, sessions, notice } = ctx;

  // deviceCols comes from queries.js so the JSON API and the dashboard read the same list.
  const verifyOf = makeVerifier(db);

  const MIN_PASSWORD = 12;
  const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

  function accountCount() {
    return db.prepare('SELECT count(*) AS c FROM admin_accounts').get().c;
  }

  async function requirePendingForApproval(device) {
    if (device.state === 'approved') throw new HttpError(409, 'already_resolved', 'device already approved');
    if (device.state === 'revoked') throw new HttpError(409, 'already_resolved', 'device is revoked');
    const current = readPolicy(db).notice_version;
    if (device.notice_version !== current) {
      // After a notice bump every device is back to pending; approving on the strength of an
      // acknowledgment of the OLD wording would silently undo the reset.
      throw new HttpError(403, 'notice_outdated',
        `device acknowledged notice ${device.notice_version ?? 'nothing'}, current is ${current}`);
    }
    if (!device.acknowledged_by || String(device.acknowledged_by).trim() === '' || !device.acknowledged_at) {
      throw new HttpError(400, 'bad_request', 'device has no recorded acknowledgment to approve against');
    }
    if (device.revoked_at && String(device.acknowledged_at) <= String(device.revoked_at)) {
      // Consent is not carried across a revocation. acknowledged_at is stored in the same
      // 'YYYY-MM-DD HH:MM:SS' UTC form as revoked_at (normalized at enrollment), so a string
      // compare is a correct time compare here.
      throw new HttpError(403, 'reacknowledgment_required',
        'the recorded acknowledgment predates the revocation; the device user must acknowledge again');
    }
  }

  const api = {
    // ---- first run: claim the initial administrator ---------------------------------------
    // GET /api/account-status is the only way the sign-in page can know whether to show a login
    // form or a claim form. It reports a count of accounts and nothing else -- no names.
    async accountStatus(req, res) {
      const count = accountCount();
      sendJson(res, 200, { accounts: count, claimable: count === 0 });
    },

    // POST /api/claim. The setup code is read from the collector's own disk (console at boot, or
    // DATA/first-run-code.txt), so claiming proves local access; there is no default password and
    // the code is deleted by this handler the first time it works.
    async claim(req, res, _p, ip) {
      const body = await readJson(req, ADMIN_BODY_MAX);
      if (accountCount() > 0) {
        ctx.setupCode.clear();
        throw new HttpError(409, 'already_claimed', 'an administrator account already exists -- sign in');
      }
      const account = String(body.account ?? '').trim();
      const password = String(body.password ?? '');
      if (!ACCOUNT_RE.test(account)) {
        throw new HttpError(400, 'bad_request',
          'account must be 3-32 characters: letters, digits, dot, dash or underscore');
      }
      if (password.length < MIN_PASSWORD || password.length > 512) {
        throw new HttpError(400, 'bad_request', `password must be ${MIN_PASSWORD}-512 characters`);
      }
      ctx.loginGuard.check(`claim:${account}`, ip);
      if (!ctx.setupCode.matches(body.code)) {
        ctx.loginGuard.noteFailure(`claim:${account}`, ip);
        audit({ actor: account, action: 'claim_refused', target: null,
          detail: 'first-run code did not match', ip });
        throw new HttpError(403, 'bad_setup_code',
          'the first-run code does not match the one printed on this collector');
      }
      const hash = await hashPassword(password);
      db.prepare('INSERT INTO admin_accounts (account, password_hash, created_at) VALUES (?, ?, datetime(\'now\'))')
        .run(account, hash);
      // A code file that outlives the account it was issued for is a liability with no purpose.
      ctx.setupCode.clear();
      ctx.loginGuard.clear(`claim:${account}`, ip);
      const { token, expiresAt } = await sessions.start(account, ip);
      audit({ actor: account, action: 'account_claimed', target: null,
        detail: 'first administrator created with the first-run code', ip });
      sendJson(res, 201, { ok: true, account, csrf: csrfFor(token), expires_at: expiresAt }, {
        'set-cookie': ctx.sessionCookie(token, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)),
      });
    },

    async login(req, res, _p, ip) {
      const body = await readJson(req, ADMIN_BODY_MAX);
      const account = String(body.account ?? '').trim();
      const password = String(body.password ?? '');
      if (!account || !password) throw new HttpError(400, 'bad_request', 'account and password required');
      ctx.loginGuard.check(account, ip);
      const row = db.prepare('SELECT password_hash FROM admin_accounts WHERE account = ?').get(account);
      const ok = row ? await verifyPassword(password, row.password_hash) : false;
      if (!ok) {
        ctx.loginGuard.noteFailure(account, ip);
        audit({ actor: account || '(empty)', action: 'login_failed', target: null, detail: null, ip });
        throw new HttpError(401, 'login_failed', 'bad credentials');
      }
      ctx.loginGuard.clear(account, ip);
      const { token, expiresAt } = await sessions.start(account, ip);
      db.prepare('UPDATE admin_accounts SET last_login_at = datetime(\'now\') WHERE account = ?').run(account);
      audit({ actor: account, action: 'login', target: null, detail: null, ip });
      // CSRF token travels in the body, not a readable-by-JS cookie: the cookie that carries the
      // session is HttpOnly, so a script that got in cannot mint its own mutation token.
      sendJson(res, 200, { csrf: csrfFor(token), expires_at: expiresAt }, {
        'set-cookie': ctx.sessionCookie(token, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)),
      });
    },

    async logout(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      sessions.end(ctx.tokenOf(req));
      audit({ actor: account, action: 'logout', target: null, detail: null, ip });
      sendJson(res, 200, { ok: true }, { 'set-cookie': ctx.clearCookie() });
    },

    async devices(req, res, _p, ip) {
      const url = new URL(req.url, 'http://x');
      const state = url.searchParams.get('state');
      const where = []; const args = [];
      if (state) { where.push('state = ?'); args.push(state); }
      const out = pagedQuery(db, 'devices', where, args, { col: 'rowid' }, pageParams(url));
      out.items = out.items.map((d) => {
        delete d.fingerprint; delete d.token_hash;
        d.verification = verifyOf(d);
        return d;
      });
      const etag = etagOfBuffer(Buffer.from(JSON.stringify(out)));
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, out, { etag });
    },

    async deviceDetail(req, res, _p, ip) {
      const id = req.params.id;
      const d = db.prepare(`SELECT ${deviceCols} FROM devices WHERE id = ?`).get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      const counts = db.prepare(`
        SELECT
          (SELECT count(*) FROM screenshots WHERE device_id = ?) AS screenshots,
          (SELECT count(*) FROM clipboard_metrics WHERE device_id = ?) AS clipboard_samples,
          (SELECT count(*) FROM extension_inventory WHERE device_id = ?) AS extension_rows,
          (SELECT count(*) FROM screen_states WHERE device_id = ?) AS screen_states,
          (SELECT max(collected_at) FROM extension_inventory WHERE device_id = ?) AS last_inventory`)
        .get(id, id, id, id, id);
      const current = policyDocument(db);
      sendJson(res, 200, {
        device: d,
        counts,
        verification: verifyOf(d),
        policy_stale: d.policy_etag !== current.etag,
        current_policy_etag: current.etag,
      });
    },

    // ---- the answer to "is this device actually working?" -------------------------------
    // Same five stamps the page renders, in the order the round trip really happens, so an
    // operator or a script gets one verdict and one reason instead of inferring it from a state
    // string that only records what the administrator intended.
    async verifyDevice(req, res, _p, ip) {
      const id = req.params.id;
      const d = db.prepare(`SELECT ${deviceCols} FROM devices WHERE id = ?`).get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      const verification = verifyOf(d);
      const counts = db.prepare(`
        SELECT
          (SELECT count(*) FROM screenshots WHERE device_id = ?) AS screenshots,
          (SELECT count(*) FROM clipboard_metrics WHERE device_id = ?) AS clipboard_samples,
          (SELECT count(*) FROM extension_inventory WHERE device_id = ?) AS extension_rows,
          (SELECT count(*) FROM screen_states WHERE device_id = ?) AS screen_states`)
        .get(id, id, id, id);
      audit({ actor: ctx.accountOf(req), action: 'device_verify', target: d.hostname,
        detail: verification.verdict, ip });
      sendJson(res, 200, {
        device_id: d.id,
        hostname: d.hostname,
        state: d.state,
        working: verification.verdict === 'working',
        verdict: verification.verdict,
        headline: verification.headline,
        detail: verification.detail,
        steps: verification.steps.map((s) => ({
          key: s.key, label: s.label, done: s.done, at: s.at ?? null, ago_ms: s.ago_ms ?? null,
        })),
        last_seen_at: d.last_seen_at,
        policy_stale: d.policy_etag !== policyDocument(db).etag,
        counts,
      });
    },

    async approve(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const id = req.params.id;
      const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      await requirePendingForApproval(d);
      // If the DB trigger aborts, the audit row must not be written as if the approval happened.
      // The three stamps are cleared in the same statement: an approval starts a new round trip,
      // and a re-approval that inherited the old stamps would report "working" before the agent
      // had done anything since.
      db.prepare(`UPDATE devices SET state = 'approved', approved_by = ?, approved_at = datetime('now'),
        token_delivered_at = NULL, first_contact_at = NULL, first_data_at = NULL WHERE id = ?`)
        .run(account, id);
      audit({ actor: account, action: 'device_approve', target: d.hostname,
        detail: `ack by ${d.acknowledged_by} on notice ${d.notice_version}`, ip });
      sendJson(res, 200, { ok: true, state: 'approved' });
    },

    async reject(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const id = req.params.id;
      const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      if (d.state === 'approved') throw new HttpError(409, 'already_resolved', 'use revoke');
      db.prepare('UPDATE devices SET state = \'rejected\', approved_by = ?, approved_at = datetime(\'now\') WHERE id = ?')
        .run(account, id);
      audit({ actor: account, action: 'device_reject', target: d.hostname, detail: null, ip });
      sendJson(res, 200, { ok: true, state: 'rejected' });
    },

    async revoke(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const body = await readJson(req, ADMIN_BODY_MAX);
      const reason = String(body.reason ?? '').trim();
      if (reason === '') throw new HttpError(400, 'bad_request', 'reason is required to revoke');
      const id = req.params.id;
      const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      db.prepare('UPDATE devices SET state = \'revoked\', revoked_by = ?, revoked_at = datetime(\'now\'), revoke_reason = ? WHERE id = ?')
        .run(account, reason, id);
      // The token is deleted so a revoked device cannot present a still-valid bearer and rely on
      // the state re-check alone; defence in depth on the one path that must stop immediately.
      db.prepare('UPDATE devices SET token_hash = NULL WHERE id = ?').run(id);
      audit({ actor: account, action: 'device_revoke', target: d.hostname, detail: reason, ip });
      sendJson(res, 200, { ok: true, state: 'revoked' });
    },

    async reenable(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const id = req.params.id;
      const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      if (!d) throw new HttpError(404, 'unknown_device', 'no such device');
      if (d.state !== 'revoked') throw new HttpError(409, 'already_resolved', 'device is not revoked');
      // Move to 'rejected' so the revoked->approved trigger no longer applies, but keep the
      // revocation fields: they are the history, and acknowledged_at <= revoked_at is exactly what
      // tells the next approval attempt that this device has not re-acknowledged since.
      db.prepare('UPDATE devices SET state = \'rejected\', policy_etag = NULL WHERE id = ?').run(id);
      audit({ actor: account, action: 'device_reenable', target: d.hostname,
        detail: 'consent not carried over; re-acknowledgment required', ip });
      sendJson(res, 200, { ok: true, state: 'rejected', requires_reacknowledgment: true });
    },

    async screenshots(req, res, _p, ip) {
      const url = new URL(req.url, 'http://x');
      const where = []; const args = [];
      const device = url.searchParams.get('device');
      if (device) { where.push('device_id = ?'); args.push(device); }
      const from = url.searchParams.get('from');
      if (from) { if (!isIso(from)) throw new HttpError(400, 'bad_request', 'from must be ISO-8601'); where.push('captured_at >= ?'); args.push(from); }
      const to = url.searchParams.get('to');
      if (to) { if (!isIso(to)) throw new HttpError(400, 'bad_request', 'to must be ISO-8601'); where.push('captured_at <= ?'); args.push(to); }
      const out = pagedQuery(db, 'screenshots', where, args, { col: 'id' }, pageParams(url));
      const etag = etagOfBuffer(Buffer.from(JSON.stringify(out)));
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, out, { etag });
    },

    async mediaScreenshot(req, res, _p, ip) {
      const row = db.prepare('SELECT * FROM screenshots WHERE id = ?').get(req.params.id);
      if (!row) throw new HttpError(404, 'unknown_route', 'no such screenshot');
      const abs = store.absolute(row.storage_key);
      if (!existsSync(abs)) throw new HttpError(410, 'bad_request', 'file expired or missing');
      const st = statSync(abs);
      const etag = `"${row.sha256}"`;
      audit({ actor: ctx.accountOf(req), action: 'screenshot_view', target: row.event_id,
        detail: `device ${row.device_id}`, ip });
      res.setHeader('etag', etag);
      res.setHeader('cache-control', 'no-store');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size });
      createReadStream(abs).pipe(res);
    },

    async extensions(req, res, _p, ip) {
      const url = new URL(req.url, 'http://x');
      const where = []; const args = [];
      const device = url.searchParams.get('device');
      if (device) { where.push('device_id = ?'); args.push(device); }
      const browser = url.searchParams.get('browser');
      if (browser) { where.push('browser = ?'); args.push(browser); }
      const out = pagedQuery(db, 'extension_inventory', where, args, { col: 'id' }, pageParams(url));
      out.items = out.items.map((r) => ({ ...r, permissions: safeParseArray(r.permissions) }));
      const etag = etagOfBuffer(Buffer.from(JSON.stringify(out)));
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, out, { etag });
    },

    async clipboard(req, res, _p, ip) {
      const url = new URL(req.url, 'http://x');
      const where = []; const args = [];
      const device = url.searchParams.get('device');
      if (device) { where.push('device_id = ?'); args.push(device); }
      const out = pagedQuery(db, 'clipboard_metrics', where, args, { col: 'id' }, pageParams(url));
      // Response shape is whitelisted column by column. Even if a future schema change added a
      // text column, SELECT * callers would leak it -- this route maps explicitly instead.
      const items = out.items.map((r) => ({
        id: r.id, device_id: r.device_id, event_id: r.event_id, sampled_at: r.sampled_at,
        char_count: r.char_count, sha256: r.sha256, content_kind: r.content_kind,
      }));
      const histogram = db.prepare(`
        SELECT content_kind, count(*) AS n, avg(char_count) AS avg_chars,
               min(char_count) AS min_chars, max(char_count) AS max_chars
        FROM clipboard_metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY content_kind`).all(...args);
      const etag = etagOfBuffer(Buffer.from(JSON.stringify({ items, histogram })));
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, { items, histogram, next_cursor: out.next_cursor, has_more: out.has_more }, { etag });
    },

    async auditList(req, res, _p, ip) {
      const url = new URL(req.url, 'http://x');
      const out = pagedQuery(db, 'audit_log', [], [], { col: 'id' }, pageParams(url));
      const etag = etagOfBuffer(Buffer.from(JSON.stringify(out)));
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, out, { etag });
    },

    async policyGet(req, res, _p, ip) {
      const { policy, etag } = policyDocument(db);
      const meta = db.prepare('SELECT key, updated_at, updated_by FROM policy').all();
      const body = { policy, etag, meta, writable: ADMIN_WRITABLE_KEYS, agent_keys: AGENT_POLICY_KEYS };
      if (conditional(res, req, etag)) return;
      sendJson(res, 200, body, { etag });
    },

    async policyPut(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const body = await readJson(req, ADMIN_BODY_MAX);
      const changed = body.changed;
      if (changed === null || typeof changed !== 'object' || Array.isArray(changed)) {
        throw new HttpError(400, 'bad_request', 'body must be {changed:{...}}');
      }
      const entries = Object.entries(changed);
      if (entries.length === 0) throw new HttpError(400, 'bad_request', 'no keys supplied');
      // Validate the whole document before writing any of it, so a rejected key cannot leave a
      // half-applied policy that no agent can satisfy.
      for (const [key, value] of entries) {
        const problem = validatePolicyWrite(key, value);
        if (problem) throw new HttpError(400, 'bad_request', `${key}: ${problem}`);
      }
      for (const [key, value] of entries) setPolicyValue(db, key, value, account);
      const { etag } = policyDocument(db);
      audit({ actor: account, action: 'policy_update', target: null,
        detail: entries.map(([k]) => k).join(','), ip });
      sendJson(res, 200, { etag, keys: entries.map(([k]) => k) });
    },

    async noticePost(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const body = await readJson(req, ADMIN_BODY_MAX);
      const version = String(body.version ?? '').trim();
      const text = String(body.text ?? '');
      if (version === '' || text.trim() === '') {
        throw new HttpError(400, 'bad_request', 'version and text are both required');
      }
      const current = readPolicy(db).notice_version;
      // A new version number does two things: replaces the wording every agent must show, and
      // invalidates every existing consent record by moving devices back to pending. Editing the
      // text at the same version number is a typo fix, and the Policy page says so in plain words,
      // so it must not strip consents that were given for this version.
      notice.setVersion(version, text, account);
      let reset = 0;
      if (version !== current) {
        db.prepare(`UPDATE devices SET state = 'pending_approval', approved_by = NULL, approved_at = NULL
          WHERE state = 'approved'`).run();
        reset = db.prepare('SELECT changes() AS c').get().c;
      }
      audit({ actor: account, action: 'notice_bump', target: version,
        detail: version === current
          ? `${current}: wording edited at the same version, consent kept`
          : `${current} -> ${version}; ${reset} devices returned to pending`, ip });
      sendJson(res, 200, { ok: true, version, returned_to_pending: reset });
    },

    async telemetryHealth(req, res, _p, ip) {
      const { etag } = policyDocument(db);
      const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const rows = healthRows(db, hourAgo);
      const body = {
        current_policy_etag: etag,
        generated_at: isoNow(),
        devices: rows.map((r) => ({
          id: r.id, hostname: r.hostname, state: r.state, last_seen_at: r.last_seen_at,
          spool_bytes: r.spool_bytes, spool_dropped: r.spool_dropped,
          bytes_sent_total: r.bytes_sent,
          bytes_last_hour: (r.bytes_now ?? 0) - (r.bytes_hour_ago ?? r.bytes_now ?? 0),
          last_flush_at: r.last_flush_at, last_flush_ms: r.last_flush_ms,
          screenshots: r.shots, screen_states: r.states,
          // policy_stale is per-device: an agent that never acks the new etag is running old rules
          // and the admin needs to see which one, not just that some device is behind.
          policy_stale: r.policy_etag !== etag,
          gap_risk: r.spool_dropped > 0,
        })),
      };
      const e = etagOfBuffer(Buffer.from(JSON.stringify(body)));
      if (conditional(res, req, e)) return;
      sendJson(res, 200, body, { etag: e });
    },

    async exportDevice(req, res, _p, ip) {
      const account = ctx.accountOf(req);
      requireCsrf(req, ctx.tokenOf(req));
      const id = req.params.device;
      // The route parameter is named :device; reading req.params.id here would be undefined and
      // every export would fail its own UUID validation.
      if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'device id must be a UUID');
      const device = db.prepare(`SELECT ${deviceCols} FROM devices WHERE id = ?`).get(id);
      if (!device) throw new HttpError(404, 'unknown_device', 'no such device');
      const payload = {
        exported_at: isoNow(),
        exported_by: account,
        device,
        screenshots: db.prepare('SELECT id, event_id, captured_at, received_at, bytes, width, height, sha256, phash, expires_at FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC').all(id),
        extension_inventory: db.prepare('SELECT event_id, collected_at, browser, profile, ext_id, name, version, source, permissions, enabled FROM extension_inventory WHERE device_id = ? ORDER BY collected_at DESC').all(id),
        clipboard_metrics: db.prepare('SELECT event_id, sampled_at, char_count, sha256, content_kind FROM clipboard_metrics WHERE device_id = ? ORDER BY sampled_at DESC').all(id),
        screen_states: db.prepare('SELECT event_id, sampled_at, state FROM screen_states WHERE device_id = ? ORDER BY sampled_at DESC').all(id),
      };
      // Recorded before the bytes go out: an export that is not logged is a data-subject request
      // nobody can account for.
      audit({ actor: account, action: 'data_export', target: device.hostname,
        detail: `device ${id}`, ip });
      const buf = Buffer.from(JSON.stringify(payload, null, 2));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': buf.length,
        'content-disposition': `attachment; filename="CTTIme-${device.hostname}-${Date.now()}.json"`,
      });
      res.end(buf);
    },
  };
  return api;
}

function safeParseArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}
