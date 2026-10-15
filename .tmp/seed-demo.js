// Scratch: put realistic content into a local collector so the dashboard can be looked at in a
// browser. Not part of the product. Screenshots captured here stay on this machine.
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createCapturer } from '../agent/lib/screenshot.js';
import { createClipboardSampler } from '../agent/lib/clipboard.js';
import { phashFromPng } from '../agent/lib/phash.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT);
const HOST = '127.0.0.1';

function call(method, p, { body, headers = {}, raw, keep = null } = {}) {
  return new Promise((resolveP, rejectP) => {
    const payload = raw ? body : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = request({
      host: HOST, port: PORT, path: p, method, rejectUnauthorized: false,
      headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html or empty */ }
        resolveP({ status: res.statusCode, headers: res.headers, json, text, buf });
      });
    });
    req.on('error', rejectP);
    if (payload) req.write(payload);
    req.end();
  });
}

const fp = (s) => createHash('sha256').update(s).digest('hex');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

// name, user, state to reach, and how much history to fake behind it
const DEVICES = [
  { hostname: 'WS-FIN-0213', user: 'a.novak', model: 'pending', os: 'Windows 11 Pro 23H2 (22631)' },
  { hostname: 'WS-ENG-1146', user: 'm.okafor', model: 'rich', os: 'Windows 11 Enterprise 24H2 (26100)' },
  { hostname: 'WS-HR-0087', user: 's.reyes', model: 'revoked', os: 'Windows 10 Pro 22H2 (19045)' },
  { hostname: 'LT-MKT-0455', user: 'd.chen', model: 'behind', os: 'Windows 11 Pro 23H2 (22631)' },
];

async function enroll(d) {
  const r = await call('POST', '/api/v1/enroll', {
    body: {
      fingerprint: fp(d.hostname), hostname: d.hostname, os_build: d.os, device_user: d.user,
      agent_version: '1.0.0', notice_version: d.notice ?? null,
      acknowledged_by: d.user, acknowledged_at: d.ackAt ?? ago(d.ackMin ?? 3),
    },
  });
  if (![200, 202].includes(r.status)) throw new Error(`enroll ${d.hostname}: ${r.status} ${r.text.slice(0, 200)}`);
  return { ...r.json, id: r.json.device_id ?? r.json.id, fingerprint: fp(d.hostname) };
}

async function status(fingerprint) {
  return (await call('GET', `/api/v1/enroll/status?fingerprint=${fingerprint}`)).json;
}

async function approve(id) {
  return call('POST', `/api/devices/${id}/approve`, { body: {}, headers: csrfHeaders() });
}

let cookie = null;
let csrf = null;
const csrfHeaders = () => ({ cookie: cookie ?? '', 'x-csrf-token': csrf, 'content-type': 'application/json' });

async function heartbeats(device, { etag, drops = 0, spool = 0, bytes = 0, times = 3, gap = 1 }) {
  for (let i = 0; i < times; i++) {
    const r = await call('POST', '/api/v1/heartbeat', {
      body: {
        policy_etag: etag, spool_bytes: spool, spool_dropped: drops,
        bytes_sent: bytes + i * 4096 * gap, agent_version: '1.0.0',
      },
      headers: { authorization: `Bearer ${device.token}` },
    });
    if (r.status === 204) continue;
    if (r.status !== 200) throw new Error(`heartbeat: ${r.status} ${r.text.slice(0, 200)}`);
    etag = r.headers['x-policy-etag'] ?? etag;
  }
  return etag;
}

async function batch(device, events) {
  const body = gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8'));
  const r = await call('POST', '/api/v1/batch', {
    raw: true, body,
    headers: {
      authorization: `Bearer ${device.token}`, 'content-encoding': 'gzip',
      'content-type': 'application/x-ndjson',
    },
  });
  if (r.status !== 200) throw new Error(`batch: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

const clipEvent = (device, min, chars, kind) => ({
  event_id: randomUUID(), type: 'clipboard_metric', device_id: device.id, ts: ago(min),
  data: {
    sampled_at: ago(min), char_count: chars, content_kind: kind,
    sha256: createHash('sha256').update(`${chars}-${min}`).digest('hex'),
  },
});

const stateEvent = (device, min, state) => ({
  event_id: randomUUID(), type: 'screen_state', device_id: device.id, ts: ago(min),
  data: { sampled_at: ago(min), state },
});

const extEvent = (device, min, browser, profile, extensions) => ({
  event_id: randomUUID(), type: 'extension_inventory', device_id: device.id, ts: ago(min),
  data: { collected_at: ago(min), browser, profile, extensions },
});

const EXT = [
  { ext_id: 'gpponghdmnpckekpmpnbadkhljfadcjh', name: 'uBlock Origin', version: '1.56.0', source: 'webstore', permissions: ['<all_urls>', 'webRequest', 'storage', 'powerful'], enabled: true },
  { ext_id: 'mihcahmgecmbnbcchbopgniflfhgnkff', name: 'Bitwarden', version: '2025.9.2', source: 'webstore', permissions: ['clipboardRead', 'storage'], enabled: true },
  { ext_id: 'nmmhkkegccagdldgiimedpiccmgmieda', name: 'Chrome Web Store Payments', version: '1.0.0.4', source: 'builtin', permissions: [], enabled: false },
  { ext_id: 'kfkieiegogfmeefgbeejbgdajgkdgkno', name: 'Corporate SSO Bridge', version: '3.2.1', source: 'sideload', permissions: ['<all_urls>', 'cookies', 'nativeMessaging'], enabled: true },
  { ext_id: 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', name: 'Docs Offline', version: '1.102.1', source: 'webstore', permissions: ['storage'], enabled: true },
];

async function captureFrames(count) {
  const work = path.join(ROOT, '.tmp', 'demo-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const capturer = createCapturer({ workDir: work, onWarn: (w) => console.log('  capture warn:', w) });
  const frames = [];
  for (let i = 0; i < count; i++) {
    const res = await capturer.capture({ idleSkipSeconds: -1, skipWhenLocked: false, timeoutMs: 25000 });
    if (res.captured) frames.push(res);
    if (i < count - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  rmSync(work, { recursive: true, force: true });
  return frames;
}

async function uploadShot(device, frame, min) {
  const r = await call('POST', '/api/v1/screenshots', {
    raw: true, body: frame.png,
    headers: {
      authorization: `Bearer ${device.token}`, 'content-type': 'application/png',
      'x-event-id': randomUUID(), 'x-device-id': device.id, 'x-captured-at': ago(min),
      'x-sha256': createHash('sha256').update(frame.png).digest('hex'),
      'x-phash': phashFromPng(frame.png) ?? '',
      'content-length': frame.png.length,
    },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`shot: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

async function main() {
  const login = await call('POST', '/api/login', { body: { account: 'itadmin', password: 'demo-pass-42' } });
  if (login.status !== 200) throw new Error(`login ${login.status}: ${login.text}`);
  cookie = login.headers['set-cookie'][0].split(';')[0];
  csrf = login.json.csrf;
  console.log('signed in as itadmin');

  const noticeVersion = (await call('GET', '/api/v1/notice')).json.version;
  for (const d of DEVICES) d.notice = noticeVersion;

  const created = [];
  for (const d of DEVICES) {
    const e = await enroll(d);
    created.push({ ...d, ...e });
  }

  const rich = created.find((d) => d.model === 'rich');
  const behind = created.find((d) => d.model === 'behind');
  const revoked = created.find((d) => d.model === 'revoked');
  const pending = created.find((d) => d.model === 'pending');
  console.log(`enrolled ${created.length}; pending id ${pending.id}`);

  for (const d of [rich, behind, revoked]) {
    const a = await approve(d.id);
    if (a.status !== 200 && a.status !== 409) throw new Error(`approve ${d.hostname}: ${a.status} ${a.text}`);
    const s = await status(d.fingerprint);
    d.token = s.token;
    if (!d.token) throw new Error(`no token for ${d.hostname}`);
  }
  console.log('approved three, issued three tokens');

  // A first config fetch establishes the etag snapshot the agent would hold.
  const cfg = await call('GET', '/api/v1/config', { headers: { authorization: `Bearer ${rich.token}` } });
  const etag = cfg.headers.etag;
  console.log('policy etag', etag);

  await heartbeats(rich, { etag, bytes: 118000, times: 4 });
  await heartbeats(behind, { etag: '"0000000000000000000000000000000"', drops: 214, spool: 6821376, bytes: 9021000, times: 2 });
  await heartbeats(revoked, { etag, bytes: 40200, times: 2 });

  await batch(rich, [
    extEvent(rich, 320, 'chrome', 'Default', EXT),
    extEvent(rich, 318, 'edge', 'Profile 1', EXT.slice(0, 3).map((x) => ({ ...x, source: 'webstore' }))),
    extEvent(rich, 300, 'firefox', 'a1b2c3d4.default', [
      { ext_id: '{b9db16a4-6f76-4b7a-bc2f-677fa01fecb4}', name: 'Dark Reader', version: '5.6.9', source: 'webstore', permissions: ['<all_urls>'], enabled: true },
      { ext_id: 'formautofill@mozilla.org', name: 'Form Autofill', version: '1.0.1', source: 'builtin', permissions: [], enabled: false },
    ]),
    ...Array.from({ length: 14 }, (_, i) => clipEvent(rich, 240 - i * 12, [0, 24, 118, 4096, 312, 58, 9][i % 7], [0, 2, 6].includes(i % 7) ? 'text' : (i % 7 === 0 ? 'empty' : 'text'))),
    ...Array.from({ length: 10 }, (_, i) => stateEvent(rich, 200 - i * 18, [ 'active', 'active', 'idle', 'locked', 'active' ][i % 5])),
    { event_id: randomUUID(), type: 'screenshot_skipped_unchanged', device_id: rich.id, ts: ago(60),
      data: { captured_at: ago(60), sha256: fp('unchanged-frame'), phash: '1887710cc3308e71' } },
  ]);
  console.log('batched extensions, clipboard metrics, screen states');

  const frames = await captureFrames(3);
  console.log(`captured ${frames.length} real frames (local only)`);
  for (const [i, f] of frames.entries()) {
    await uploadShot(rich, f, 6 + i * 11);
  }

  await batch(behind, [
    extEvent(behind, 90, 'chrome', 'Default', EXT.slice(1, 4)),
    ...Array.from({ length: 6 }, (_, i) => clipEvent(behind, 80 - i * 9, [12, 0, 340, 78, 1500, 44][i], 'text')),
    ...Array.from({ length: 5 }, (_, i) => stateEvent(behind, 70 - i * 11, ['idle', 'active', 'locked'][i % 3])),
  ]);
  await heartbeats(behind, { etag: behind.heldEtag ?? '"0000000000000000000000000000000"', drops: 214, spool: 6821376, bytes: 9100000, times: 1 });

  if (frames[0]) await uploadShot(behind, frames[0], 25);

  await batch(revoked, [
    extEvent(revoked, 150, 'edge', 'Default', EXT.slice(2, 5)),
    ...Array.from({ length: 5 }, (_, i) => clipEvent(revoked, 140 - i * 15, [0, 88, 12][i % 3], 'text')),
    ...Array.from({ length: 4 }, (_, i) => stateEvent(revoked, 130 - i * 20, 'active')),
  ]);
  if (frames[1]) await uploadShot(revoked, frames[1], 120);

  const rv = await call('POST', `/api/devices/${revoked.id}/revoke`, {
    body: { reason: 'Offboarding: laptop returned to lease company' }, headers: csrfHeaders(),
  });
  console.log('revocation', rv.status, JSON.stringify(rv.json));
  await call('POST', '/api/policy', { body: { changed: { screenshot_interval_minutes: 4 } }, headers: csrfHeaders() });
  await call('GET', `/api/screenshots?device=${rich.id}`, { headers: csrfHeaders() });
  await call('GET', '/api/audit?limit=5', { headers: csrfHeaders() });

  console.log('\ndashboard: https://127.0.0.1:%d  (itadmin / demo-pass-42)', PORT);
  console.log('devices:', created.map((d) => `${d.hostname}=${d.model}`).join(' '));
}

main().catch((err) => { console.error('seed failed:', err.message); process.exitCode = 1; });
