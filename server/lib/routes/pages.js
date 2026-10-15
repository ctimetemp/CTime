// The dashboard's HTML surface. Pages and the fragments they poll are produced by the same
// render functions in render.js, so what the browser refreshes is byte-identical to what the
// server first sent -- there is no second template language to keep in sync.
import {
  HttpError, sendHtml, conditional, etagOfBuffer, pageParams,
} from '../httpkit.js';
import { pagedQuery } from '../db.js';
import {
  healthRows, overviewCounts, SHOTS_FROM, EXT_FROM, CLIP_FROM, DEVICE_COLS, makeVerifier,
} from '../queries.js';
import { policyDocument, readPolicy, ADMIN_WRITABLE_KEYS, BOUNDS } from '../policy.js';
import { csrfFor } from '../auth.js';
import { isUuid } from '../validate.js';
import {
  layout, pagePending, pageDevices, pageCounts, pageDetail, pageShots, pageExtensions,
  pageClipboard, pageAudit, pageHealth, pagePolicy, pageLogin, pageClaim, pageHelp, pageChecklist,
} from '../render.js';

function accountCount(db) {
  return db.prepare('SELECT count(*) AS c FROM admin_accounts').get().c;
}

const FILTER_KEYS = ['device', 'browser'];

// Filter query string, deliberately excluding `cursor`: a polled region must never refresh a
// deep page back to the newest rows, because that replaces rows the operator is reading.
function qs(url) {
  const q = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = url.searchParams.get(key);
    if (v) q.set(key, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function deviceFilter(url, where, args) {
  const device = url.searchParams.get('device');
  if (!device) return;
  if (!isUuid(device)) throw new HttpError(400, 'bad_request', 'device filter must be a UUID');
  where.push('device_id = ?');
  args.push(device);
}

export function createPages({ db, notice, audit }) {
  function shell(req, res, title, path, body) {
    const counts = overviewCounts(db);
    sendHtml(res, 200, layout({
      title, path, body,
      account: req.account ?? null,
      csrf: req.sessionToken ? csrfFor(req.sessionToken) : null,
      pending: counts.pending,
      noticeVersion: readPolicy(db).notice_version ?? null,
    }));
  }

  function fragment(req, res, html) {
    const etag = etagOfBuffer(Buffer.from(html));
    if (conditional(res, req, etag)) return;
    sendHtml(res, 200, html, { etag, 'cache-control': 'no-cache' });
  }

  const now = () => Date.now();
  const verify = makeVerifier(db);

  // Every row the tables render carries the same verdict object the JSON API returns, so a chip on
  // the page and a curl of /api/devices say the same thing about the same device.
  const withVerification = (rows) => rows.map((d) => ({ ...d, verification: verify(d) }));

  // Option lists for the filter selects. The device filter is a UUID column, so free text could
  // only ever produce an error; listing the enrolled hostnames makes the filter unmissable.
  const deviceOptions = () => db
    .prepare('SELECT id, hostname FROM devices ORDER BY hostname LIMIT 500')
    .all().map((d) => ({ value: d.id, label: d.hostname }));
  const browserOptions = () => db
    .prepare('SELECT DISTINCT browser FROM extension_inventory ORDER BY browser')
    .all().map((r) => ({ value: r.browser, label: r.browser }));

  const pendingSection = (poll) => pagePending({
    items: withVerification(pagedQuery(db, 'devices', ["state = 'pending_approval'"], [],
      { col: 'rowid' }, { limit: 50, cursor: null }).items),
    now: now(), poll,
  });

  const devicesSection = (poll) => pageDevices({
    items: withVerification(pagedQuery(db, 'devices', [], [],
      { col: 'rowid' }, { limit: 100, cursor: null }).items),
    now: now(), poll,
  });

  const healthSection = (poll) => {
    const { etag } = policyDocument(db);
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const rows = healthRows(db, hourAgo).map((r) => ({
      ...r,
      screenshots: r.shots,
      screen_states: r.states,
      bytes_last_hour: (r.bytes_now ?? 0) - (r.bytes_hour_ago ?? r.bytes_now ?? 0),
      // Per device, not a global "some agent is behind": an admin needs to know which endpoint is
      // still running the old rules.
      policy_stale: r.policy_etag !== etag,
    }));
    return pageHealth({ devices: rows, currentEtag: etag, now: now(), poll });
  };

  // One definition per paged view; the page handler wraps it in the shell, the fragment handler
  // wraps it in an ETag. Same query, same rows, same numbers.
  const views = {
    shots: {
      key: 'shots', title: 'Screenshots', path: '/screenshots', frag: 'shots',
      build(url, p, poll) {
        const where = []; const args = [];
        deviceFilter(url, where, args);
        const out = pagedQuery(db, SHOTS_FROM, where, args, { col: 'id' }, p);
        return pageShots({ items: out.items, next: out.next_cursor, hasMore: out.has_more,
          hrefBase: this.path + qs(url), poll, deviceOptions: deviceOptions() });
      },
    },
    extensions: {
      key: 'extensions', title: 'Extensions', path: '/extensions', frag: 'extensions',
      build(url, p, poll) {
        const where = []; const args = [];
        deviceFilter(url, where, args);
        const browser = url.searchParams.get('browser');
        if (browser) { where.push('browser = ?'); args.push(browser); }
        const out = pagedQuery(db, EXT_FROM, where, args, { col: 'id' }, p);
        return pageExtensions({ items: out.items, next: out.next_cursor, hasMore: out.has_more,
          hrefBase: this.path + qs(url), poll, deviceOptions: deviceOptions(), browserOptions: browserOptions() });
      },
    },
    clipboard: {
      key: 'clipboard', title: 'Clipboard metrics', path: '/clipboard', frag: 'clipboard',
      build(url, p, poll) {
        const where = []; const args = [];
        deviceFilter(url, where, args);
        const out = pagedQuery(db, CLIP_FROM, where, args, { col: 'id' }, p);
        const histogram = db.prepare(`
          SELECT content_kind, count(*) AS n, avg(char_count) AS avg_chars,
                 min(char_count) AS min_chars, max(char_count) AS max_chars
          FROM clipboard_metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY content_kind`).all(...args);
        return pageClipboard({ items: out.items, histogram, next: out.next_cursor,
          hasMore: out.has_more, hrefBase: this.path + qs(url), poll, now: now(),
          deviceOptions: deviceOptions() });
      },
    },
    audit: {
      key: 'audit', title: 'Audit log', path: '/audit', frag: 'audit',
      build(url, p, poll) {
        const out = pagedQuery(db, 'audit_log', [], [], { col: 'id' }, p);
        return pageAudit({ items: out.items, next: out.next_cursor, hasMore: out.has_more,
          hrefBase: this.path, poll, now: now() });
      },
    },
  };

  const api = {
    overview(req, res) {
      const counts = overviewCounts(db);
      const verdicts = db.prepare(`SELECT ${DEVICE_COLS} FROM devices`).all().map(verify);
      const tally = {
        working: verdicts.filter((v) => v.verdict === 'working').length,
        waiting: verdicts.filter((v) => v.tone === 'warn').length,
        stopped: verdicts.filter((v) => v.tone === 'bad').length,
      };
      const acknowledged = verdicts.filter((v) => v.steps[0].done).length;
      shell(req, res, 'Overview', '/',
        (tally.working === 0 ? pageChecklist({ counts, acknowledged, working: tally.working }) : '')
        + pageCounts({ counts, tally, etag: policyDocument(db).etag })
        + pendingSection('/fragments/pending') + devicesSection('/fragments/devices'));
    },

    device(req, res, params, ip) {
      const id = params.id;
      if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'device id must be a UUID');
      const device = db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).get(id);
      if (!device) throw new HttpError(404, 'unknown_device', 'no such device');
      const counts = db.prepare(`
        SELECT
          (SELECT count(*) FROM screenshots WHERE device_id = ?) AS screenshots,
          (SELECT count(*) FROM clipboard_metrics WHERE device_id = ?) AS clipboard_samples,
          (SELECT count(*) FROM extension_inventory WHERE device_id = ?) AS extension_rows,
          (SELECT count(*) FROM screen_states WHERE device_id = ?) AS screen_states,
          (SELECT max(collected_at) FROM extension_inventory WHERE device_id = ?) AS last_inventory`)
        .get(id, id, id, id, id);
      const current = policyDocument(db);
      const verification = verify(device);
      // "Confirm this device" is a plain link, so it works with no JavaScript at all. The query
      // flag exists to mark the deliberate check in the audit log -- an operator asking whether a
      // device is reporting is a fact worth recording next to the approvals.
      if (new URL(req.url, 'http://x').searchParams.get('verify') === '1') {
        audit({ actor: req.account ?? 'anonymous', action: 'device_verify', target: device.hostname,
          detail: verification.verdict, ip });
      }
      const recent = (from, limit) => pagedQuery(db, from, ['device_id = ?'], [id],
        { col: 'id' }, { limit, cursor: null }).items;
      shell(req, res, device.hostname, '/', pageDetail({
        device, counts,
        verification,
        policyStale: device.policy_etag !== current.etag,
        currentEtag: current.etag,
        now: now(),
        shots: recent('screenshots', 6),
        extensions: recent('extension_inventory', 12),
        clipboard: recent('clipboard_metrics', 12),
      }));
    },

    health(req, res) {
      shell(req, res, 'Telemetry health', '/health', healthSection('/fragments/health'));
    },

    policy(req, res) {
      const { policy, etag } = policyDocument(db);
      shell(req, res, 'Policy', '/policy', pagePolicy({
        policy,
        meta: db.prepare('SELECT key, updated_at, updated_by FROM policy').all(),
        writable: ADMIN_WRITABLE_KEYS,
        bounds: BOUNDS,
        noticeVersion: readPolicy(db).notice_version,
        noticeText: notice.text(),
        etag,
      }));
    },

    loginPage(req, res) {
      if (req.account) {
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }
      const params = new URL(req.url, 'http://x').searchParams;
      const error = params.get('error');
      // A collector with no administrator has no point offering a sign-in form: every credential
      // would be wrong, and the one thing the operator needs to do is create the first account.
      // The first-run code itself is never rendered here -- only where to go and read it.
      const body = accountCount(db) === 0 ? pageClaim({ error }) : pageLogin({ error });
      sendHtml(res, 200, layout({ title: 'Sign in', path: '/login', body }));
    },

    helpPage(req, res) {
      shell(req, res, 'Help', '/help', pageHelp());
    },

    fragPending(req, res) { fragment(req, res, pendingSection('/fragments/pending')); },
    fragDevices(req, res) { fragment(req, res, devicesSection('/fragments/devices')); },
    fragHealth(req, res) { fragment(req, res, healthSection('/fragments/health')); },
  };

  for (const view of Object.values(views)) {
    api[view.key] = (req, res) => {
      const url = new URL(req.url, 'http://x');
      const p = pageParams(url);
      const poll = p.cursor === null ? `/fragments/${view.frag}${qs(url)}` : null;
      shell(req, res, view.title, view.path, view.build(url, p, poll));
    };
    api[`frag${view.frag[0].toUpperCase()}${view.frag.slice(1)}`] = (req, res) => {
      const url = new URL(req.url, 'http://x');
      fragment(req, res, view.build(url, pageParams(url), `/fragments/${view.frag}${qs(url)}`));
    };
  }

  // Region names collide: the shots page is /screenshots while its fragment is /fragments/shots.
  api.screenshots = api.shots;
  return api;
}
