// Acceptance harness. Boots the real collector on an ephemeral port, drives it over the pinned TLS
// listener exactly as an agent and the dashboard do, then exercises the agent-side components
// in-process. Every check maps to a line in the build brief; the names quote it.
//
// Run: node test/run.js

import { spawn } from 'node:child_process';
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.tmp', 'acceptance');

const results = [];
let failed = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? null });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --------------------------------------------------------------------------------------------
// harness plumbing
// --------------------------------------------------------------------------------------------

let port = null;
let pin = null;
let child = null;

function http(method, urlPath, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolveP, rejectP) => {
    const payload = raw ? body : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = request({
      host: '127.0.0.1', port, path: urlPath, method, rejectUnauthorized: false,
      headers: {
        ...(payload && !headers['content-length'] ? { 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // `raw` means "give me the bytes too" (PNG bodies), not "never parse": a JSON response
        // with raw:true is still JSON, and the batch/screenshot checks read both.
        const isJson = String(res.headers['content-type'] ?? '').includes('json');
        let parsed = null;
        if (buf.length && (!raw || isJson)) { try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; } }
        resolveP({ status: res.statusCode, headers: res.headers, json: parsed, buf });
      });
    });
    req.on('error', rejectP);
    if (payload) req.write(payload);
    req.end();
  });
}

// A body the server is expected to refuse: the response and the socket teardown race, so an
// ECONNRESET here is reported as "connection closed before the status arrived" rather than
// silently passing the check.
async function httpExpectRefused(method, urlPath, opts) {
  try {
    return await http(method, urlPath, opts);
  } catch (err) {
    return { status: 0, json: null, buf: Buffer.alloc(0), headers: {}, socketError: err.code ?? err.message };
  }
}

const COLLECTOR_ACCOUNT = 'itadmin';
const COLLECTOR_PASSWORD = 'acceptance-pass-42';

async function waitForCollector(lines) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const text = lines.join('');
    const m = /cert SHA-256\s+([0-9a-f]{64})/.exec(text);
    const listen = /listening\s+https:\/\/[\d.]+:(\d+)/.exec(text);
    if (m && listen) {
      pin = m[1];
      port = Number(listen[1]);
      return;
    }
    if (/EADDRINUSE|Error:/.test(text)) throw new Error(`collector failed to start:\n${text}`);
    await sleep(150);
  }
  throw new Error(`collector did not come up in time:\n${lines.join('')}`);
}

async function startCollector(env, { fresh = true } = {}) {
  if (fresh) rmSync(path.join(TMP, 'server-data'), { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'server-data'), { recursive: true });
  const lines = [];
  const baseEnv = {
    ...process.env,
    CTTIme_PORT: '0',
    CTTIme_DB: path.join(TMP, 'server-data', 'collector.db'),
    CTTIme_SHOTS: path.join(TMP, 'server-data', 'screenshots'),
    CTTIme_DATA: path.join(TMP, 'server-data'),
    ...env,
  };
  // The collector binds an ephemeral port and prints its own fingerprint, which is exactly the
  // boot information an operator needs, so the harness reads it from stdout rather than guessing.
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: baseEnv, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(`[stderr] ${String(d)}`));
  child.on('exit', (code) => { if (code !== 0 && code !== null) lines.push(`[exit ${code}]`); });
  await waitForCollector(lines);
  child.__lines = lines;
  return { port, pin };
}

async function stopCollector() {
  if (child && !child.killed) child.kill();
  await sleep(300);
  child = null;
}

let csrf = null;
let cookie = null;

async function adminLogin() {
  const r = await http('POST', '/api/login', {
    body: { account: COLLECTOR_ACCOUNT, password: COLLECTOR_PASSWORD },
  });
  assert(r.status === 200, `login returned ${r.status}: ${JSON.stringify(r.json)}`);
  csrf = r.json.csrf;
  cookie = r.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  return r.json;
}

const adminHeaders = (extra = {}) => ({ cookie: cookie ?? '', 'x-csrf-token': csrf ?? '', ...extra });

let noticeVersionCache = null;
async function getNoticeVersion() {
  if (noticeVersionCache) return noticeVersionCache;
  const r = await http('GET', '/api/v1/notice');
  noticeVersionCache = r.json.version;
  return noticeVersionCache;
}

async function enroll(fingerprint, { acknowledgedBy = 'A. Novak', hostname = 'ACCEPTANCE-BOX', ...over } = {}) {
  return http('POST', '/api/v1/enroll', {
    body: {
      fingerprint,
      hostname,
      os_build: '10.0.26100',
      device_user: 'a.novak',
      agent_version: '1.0.0',
      notice_version: over.notice_version ?? (await getNoticeVersion()),
      acknowledged_by: acknowledgedBy,
      acknowledged_at: over.acknowledged_at ?? new Date().toISOString(),
    },
  });
}

const approve = (deviceId) =>
  http('POST', `/api/devices/${deviceId}/approve`, { body: {}, headers: adminHeaders() });

async function makeApprovedDevice(fp) {
  const e = await enroll(fp);
  assert(e.status === 202, `enroll expected 202 got ${e.status} ${JSON.stringify(e.json)}`);
  const a = await approve(e.json.device_id);
  assert(a.status === 200, `approve expected 200 got ${a.status} ${JSON.stringify(a.json)}`);
  const s = await http('GET', `/api/v1/enroll/status?fingerprint=${fp}`);
  assert(s.json.token, 'no token delivered on approval');
  return { deviceId: e.json.device_id, token: s.json.token };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const now = () => new Date().toISOString();
const clipData = (i) => ({ sampled_at: now(), char_count: i, sha256: '0'.repeat(64), content_kind: 'text' });

// A minimal but genuinely valid PNG, produced with node:zlib so no binary fixture is committed.
function makePng(width = 64, height = 48, seed = 1) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = ((x * 7 + y * 13 + seed * 29) & 0xff);
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Synthetic browser profiles. Deliberately not the operator's real ones: fixtures are the only way
// to exercise a missing profile, a profile with no extension key, and a corrupt file at all, and
// reading a real Chrome/Edge/Firefox profile is a separate decision about a real device.
function writeBrowserFixtures(dir) {
  const chromium = (browser, dirParts, profile, settings, { corrupt = false, noExtensions = false } = {}) => {
    const userData = path.join(dir, 'Local', ...dirParts);
    const profileDir = path.join(userData, profile);
    mkdirSync(profileDir, { recursive: true });
    // A profile is only recognised when Preferences exists, so write one either way.
    if (noExtensions) {
      writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({ account_id: 12345 }));
      return;
    }
    if (corrupt) {
      writeFileSync(path.join(profileDir, 'Secure Preferences'), '{ this is not json');
      writeFileSync(path.join(profileDir, 'Preferences'), '{ also not json');
      return;
    }
    writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({ account_id: 12345 }));
    writeFileSync(path.join(profileDir, 'Secure Preferences'),
      JSON.stringify({ extensions: { settings } }));
  };

  chromium('chrome', ['Google', 'Chrome', 'User Data'], 'Default', {
    chromeExtId11111111111111111111: {
      contents: { name: 'Acceptance Extension', version: '1.4.2' },
      state: 1,
      permissions: ['tabs', 'storage'],
      fromWebstore: true,
    },
    chromeDisabled00000000000000000000: {
      contents: { name: 'Turned Off Ext', version: '0.9' },
      state: 0,
      fromWebstore: true,
    },
    // Browser-shipped and expected to be filtered out of the inventory.
    nmmhkkegccagdldgiimedpiccmgmieda: {
      contents: { name: 'Google Wallet', version: '1.0' }, state: 1,
    },
    // An entry with no name and no path: the parser must fall back to the id, not throw.
    malformedEntryNoName0000000000000000: {},
  });
  chromium('edge', ['Microsoft', 'Edge', 'User Data'], 'Profile 1', {
    edgeExtId1111111111111111111111111: {
      contents: { name: 'Edge Acceptance Ext', version: '2.0' },
      state: 1,
      path: 'C:\\ext\\sideloaded',
    },
  });
  // Absent-key and corrupt profiles: both must contribute nothing and must not crash the agent.
  chromium('chrome', ['Google', 'Chrome', 'User Data'], 'Profile 2', null, { noExtensions: true });
  chromium('brave', ['BraveSoftware', 'Brave-Browser', 'User Data'], 'Default', null, { corrupt: true });

  const ffProfile = path.join(dir, 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'ab12cd34.default');
  mkdirSync(ffProfile, { recursive: true });
  writeFileSync(path.join(ffProfile, 'extensions.json'), JSON.stringify({
    addons: [
      {
        id: 'acceptance@extension.test', name: 'Firefox Acceptance', version: '3.1',
        appDisabled: false, userDisabled: false, rootURI: 'https://addons.example',
        permissions: ['<all_urls>'],
      },
      {
        id: 'disabled@extension.test', name: 'Firefox Disabled', version: '1.0',
        appDisabled: false, userDisabled: true, rootURI: 'file:///p/',
      },
      null,
      { id: 'builtin@mozilla.org', builtIn: true },
    ],
  }));
  // A profiles directory entry with no extensions.json is the normal case on a fresh install.
  mkdirSync(path.join(dir, 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'emptyprofile.default'),
    { recursive: true });
}

// --------------------------------------------------------------------------------------------

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  console.log('\nCTTIme acceptance\n==================\n');

  await startCollector({ CTTIme_BOOTSTRAP_ACCOUNT: `${COLLECTOR_ACCOUNT}:${COLLECTOR_PASSWORD}` });
  await adminLogin();

  console.log('\nConsent gate');
  await check('node server/index.js boots and prints the bind address + cert fingerprint', async () => {
    assert(port > 0 && port !== 8443, `ephemeral port was ${port}`);
    assert(/^[0-9a-f]{64}$/.test(pin), `bad fingerprint ${pin}`);
    return `https://127.0.0.1:${port}, pin ${pin.slice(0, 12)}…`;
  });

  await check('schema loads on a fresh database', async () => {
    const r = await http('GET', '/api/devices', { headers: adminHeaders() });
    assert(r.status === 200, `devices list ${r.status}`);
    return `${r.json.items.length} devices`;
  });

  await check('approving a device with acknowledged_at NULL is aborted by the DB trigger', async () => {
    // Same schema file the collector loaded, driven with raw SQL, so the abort is demonstrated at
    // the database layer rather than only through an app route that could refuse first.
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(path.join(ROOT, 'server', 'lib', 'schema.sql'), 'utf8'));
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO devices (id, fingerprint, hostname, os_build, device_user,
        agent_version, enrolled_at, notice_version, acknowledged_by)
      VALUES (?, ?, 'H', '10.0', 'u', '1.0', datetime('now'), 'v1', 'Name Present')`)
      .run(id, 'a'.repeat(64));
    let blocked = null;
    try {
      db.prepare('UPDATE devices SET state = ? WHERE id = ?').run('approved', id);
    } catch (err) { blocked = err.message; }
    assert(blocked && /acknowledgment/.test(blocked), `trigger did not fire (got ${blocked})`);

    // The blank-name forms the app layer also has to survive: '' and whitespace-only.
    const blank = [];
    for (const value of ['', '   ']) {
      const b = crypto.randomUUID();
      db.prepare(`INSERT INTO devices (id, fingerprint, hostname, os_build, device_user,
          agent_version, enrolled_at, notice_version, acknowledged_by, acknowledged_at)
        VALUES (?, ?, 'H', '10.0', 'u', '1.0', datetime('now'), 'v1', ?, datetime('now'))`)
        .run(b, 'b'.repeat(60) + String(value.length).padStart(4, '0'), value);
      let msg = null;
      try { db.prepare('UPDATE devices SET state = ? WHERE id = ?').run('approved', b); }
      catch (err) { msg = err.message; }
      blank.push(`${JSON.stringify(value)}: ${msg ? 'blocked' : 'ALLOWED'}`);
      assert(msg, `blank acknowledged_by ${JSON.stringify(value)} was approvable`);
    }
    // And the positive control: full consent must be approvable, or this is just a broken trigger.
    const ok = crypto.randomUUID();
    db.prepare(`INSERT INTO devices (id, fingerprint, hostname, os_build, device_user,
        agent_version, enrolled_at, notice_version, acknowledged_by, acknowledged_at)
      VALUES (?, ?, 'H', '10.0', 'u', '1.0', datetime('now'), 'v1', 'Real Name', datetime('now'))`)
      .run(ok, 'c'.repeat(64));
    db.prepare('UPDATE devices SET state = ? WHERE id = ?').run('approved', ok);
    const row = db.prepare('SELECT state FROM devices WHERE id = ?').get(ok);
    assert(row.state === 'approved', 'a fully consented device could not be approved');
    db.close();
    return `RAISE(ABORT) fired; ${blank.join('; ')}; consented row approved`;
  });

  await check('empty acknowledged_by is refused at enrollment', async () => {
    const r = await http('POST', '/api/v1/enroll', {
      body: {
        fingerprint: 'd'.repeat(64), hostname: 'X', os_build: '10.0', device_user: 'x',
        agent_version: '1.0.0', notice_version: await getNoticeVersion(),
        acknowledged_by: '   ', acknowledged_at: now(),
      },
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
    assert(/acknowledged_by/.test(r.json.detail), `detail was ${r.json.detail}`);
    return r.json.detail;
  });

  await check('a fabricated acknowledgment timestamp is refused', async () => {
    const r = await http('POST', '/api/v1/enroll', {
      body: {
        fingerprint: 'e'.repeat(64), hostname: 'X', os_build: '10.0', device_user: 'x',
        agent_version: '1.0.0', notice_version: await getNoticeVersion(),
        acknowledged_by: 'Time Traveller', acknowledged_at: '2020-01-01T00:00:00.000Z',
      },
    });
    assert(r.status === 400 && /clock_skew/.test(r.json.detail), `got ${r.status} ${JSON.stringify(r.json)}`);
    return 'clock_skew';
  });

  console.log('\nIngest authorisation');
  let approved = null;
  await check('ingest from an unapproved device is refused and no token is issued', async () => {
    const e = await enroll('1'.repeat(64), { hostname: 'PENDING-BOX' });
    assert(e.status === 202 && e.json.state === 'pending_approval', `enroll ${e.status} ${JSON.stringify(e.json)}`);
    const s = await http('GET', `/api/v1/enroll/status?fingerprint=${'1'.repeat(64)}`);
    assert(!s.json.token, 'pending device must not receive a token');
    const unknown = await http('POST', '/api/v1/clipboard-metric', {
      body: clipData(3), headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert(unknown.status === 401, `unknown token expected 401 got ${unknown.status}`);
    // A token for a device that has since left the approved state must yield 403, not 401.
    const withToken = await http('POST', '/api/v1/clipboard-metric', {
      body: clipData(4), headers: bearer('f'.repeat(32)),
    });
    assert(withToken.status === 401, `garbage token expected 401 got ${withToken.status}`);
    return 'no token while pending; 401 for an unknown bearer token';
  });

  await check('approved device ingest returns 201', async () => {
    approved = await makeApprovedDevice('2'.repeat(64));
    const r = await http('POST', '/api/v1/clipboard-metric', {
      body: { sampled_at: now(), char_count: 12, sha256: createHash('sha256').update('hello').digest('hex'), content_kind: 'text' },
      headers: bearer(approved.token),
    });
    assert(r.status === 201, `expected 201 got ${r.status} ${JSON.stringify(r.json)}`);
    return `event ${r.json.event_id}`;
  });

  console.log('\nClipboard content prohibition');
  await check('a content key on /clipboard-metric is rejected and audit-logged', async () => {
    const r = await http('POST', '/api/v1/clipboard-metric', {
      body: { ...clipData(5), content: 'super secret password' },
      headers: bearer(approved.token),
    });
    assert(r.status === 422, `expected 422 got ${r.status} ${JSON.stringify(r.json)}`);
    const audit = await http('GET', '/api/audit?limit=20', { headers: adminHeaders() });
    const logged = audit.json.items.find((a) => a.action === 'clipboard_content_rejected');
    assert(logged, 'no audit row written');
    assert(!JSON.stringify(audit.json.items).includes('super secret'),
      'the content value leaked into audit_log');
    return `422 + audit row keyed "${logged.detail}", value not stored`;
  });

  await check('a content key inside one batch line rejects the whole batch', async () => {
    const good = (i) => ({
      event_id: crypto.randomUUID(), type: 'clipboard_metric', device_id: approved.deviceId,
      ts: now(), data: clipData(i),
    });
    const bad = {
      event_id: crypto.randomUUID(), type: 'clipboard_metric', device_id: approved.deviceId,
      ts: now(), data: { ...clipData(4), text: 'leaked clipboard' },
    };
    const lines = [good(1), good(2), bad, good(3)];
    const body = gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')));
    const r = await http('POST', '/api/v1/batch', {
      raw: true, body,
      headers: {
        ...bearer(approved.token), 'content-encoding': 'gzip',
        'content-type': 'application/x-ndjson', 'content-length': body.length,
      },
    });
    assert(r.status === 422, `expected 422 got ${r.status} ${r.buf.toString().slice(0, 200)}`);
    // The three good lines must not have been written: partial acceptance would make the
    // whole-batch rule a lie.
    const clip = await http('GET', `/api/clipboard?device=${approved.deviceId}`, { headers: adminHeaders() });
    assert(!JSON.stringify(clip.json).includes('leaked clipboard'), 'content reached the database');
    const charCounts = clip.json.items.map((i) => i.char_count);
    for (const expected of [1, 2, 3]) {
      assert(!charCounts.includes(expected),
        `good line char_count=${expected} was accepted anyway (saw ${charCounts.join(',')})`);
    }
    return `whole batch refused; db holds ${clip.json.items.length} row(s), all from the single route`;
  });

  await check('no schema column can hold clipboard text', async () => {
    const cols = dbColumnsOf('clipboard_metrics').sort();
    const allowed = ['char_count', 'content_kind', 'device_id', 'event_id', 'id', 'sampled_at', 'sha256'];
    assert(cols.join() === allowed.join(), `clipboard_metrics columns are ${cols.join(', ')}`);
    const sql = readFileSync(path.join(ROOT, 'server', 'lib', 'schema.sql'), 'utf8').toLowerCase();
    // Comment lines wrap, so compare against the file with the SQL comment markers removed.
    const flat = sql.replace(/--[^\n]*/g, (m) => `${m.slice(2)} `).replace(/\s+/g, ' ');
    assert(/no column anywhere in this file capable of holding clipboard text/.test(flat),
      'the schema does not state the prohibition');
    return `clipboard_metrics(${cols.join(', ')}) — only count, hash and kind`;
  });

  console.log('\nReal PNG ingest');
  await check('streamed PNG upload stores dimensions and rejects a wrong sha', async () => {
    const png = makePng(320, 200, 3);
    const sha = createHash('sha256').update(png).digest('hex');
    const r = await http('POST', '/api/v1/screenshots', {
      raw: true, body: png,
      headers: {
        ...bearer(approved.token), 'content-type': 'application/png', 'content-length': png.length,
        'x-event-id': crypto.randomUUID(), 'x-device-id': approved.deviceId,
        'x-captured-at': now(), 'x-sha256': sha, 'x-phash': 'a09272b0b0b08081',
      },
    });
    assert(r.status === 201, `expected 201 got ${r.status} ${r.buf.toString()}`);
    const list = await http('GET', `/api/screenshots?device=${approved.deviceId}`, { headers: adminHeaders() });
    const row = list.json.items.find((i) => i.id === r.json.id);
    assert(row.width === 320 && row.height === 200, `dimensions were ${row.width}x${row.height}`);
    assert(row.sha256 === sha, 'stored sha differs');
    assert(row.phash === 'a09272b0b0b08081', 'phash header not stored');
    assert(row.expires_at > now(), 'retention deadline is not in the future');

    const bad = await http('POST', '/api/v1/screenshots', {
      raw: true, body: png,
      headers: {
        ...bearer(approved.token), 'content-type': 'application/png', 'content-length': png.length,
        'x-event-id': crypto.randomUUID(), 'x-device-id': approved.deviceId,
        'x-captured-at': now(), 'x-sha256': 'f'.repeat(64),
      },
    });
    assert(bad.status === 400, `wrong sha expected 400 got ${bad.status}`);
    const notPng = await http('POST', '/api/v1/screenshots', {
      raw: true, body: Buffer.from('GIF89a not a png at all'),
      headers: {
        ...bearer(approved.token), 'content-type': 'application/png',
        'x-event-id': crypto.randomUUID(), 'x-device-id': approved.deviceId, 'x-captured-at': now(),
      },
    });
    assert(notPng.status === 400 || notPng.status === 0, `non-PNG got ${notPng.status}`);
    return '320x200 stored with dimensions + expiry; mismatched X-Sha256 and non-PNG refused';
  });

  await check('duplicate event_id on screenshot is a no-op, not a second row', async () => {
    const png = makePng(100, 100, 7);
    const eventId = crypto.randomUUID();
    const headers = {
      ...bearer(approved.token), 'content-type': 'application/png', 'content-length': png.length,
      'x-event-id': eventId, 'x-device-id': approved.deviceId, 'x-captured-at': now(),
    };
    const a = await http('POST', '/api/v1/screenshots', { raw: true, body: png, headers });
    const b = await http('POST', '/api/v1/screenshots', { raw: true, body: png, headers });
    assert(a.status === 201 && b.status === 200 && b.json.duplicate === true,
      `got ${a.status}/${b.status} ${b.buf.toString()}`);
    assert(a.json.id === b.json.id, 'duplicate returned a different id');
    return `id ${a.json.id} reused`;
  });

  console.log('\nEfficiency contract');
  await check('unchanged config poll returns 304 with a zero-byte body', async () => {
    const first = await http('GET', '/api/v1/config', { headers: bearer(approved.token) });
    assert(first.status === 200, `first ${first.status}`);
    const etag = first.headers.etag;
    const again = await http('GET', '/api/v1/config', {
      headers: { ...bearer(approved.token), 'if-none-match': etag },
    });
    assert(again.status === 304, `expected 304 got ${again.status}`);
    assert(again.buf.length === 0, `304 body was ${again.buf.length} bytes`);
    return `etag ${etag}, response 0 bytes`;
  });

  await check('unchanged heartbeat returns 204 with a zero-byte body', async () => {
    const cfg = await http('GET', '/api/v1/config', { headers: bearer(approved.token) });
    const hbBody = { policy_etag: cfg.headers.etag, spool_bytes: 0, spool_dropped: 0, bytes_sent: 0 };
    const r = await http('POST', '/api/v1/heartbeat', { body: hbBody, headers: bearer(approved.token) });
    assert(r.status === 204, `expected 204 got ${r.status}`);
    assert(r.buf.length === 0, `204 body was ${r.buf.length} bytes`);
    return `response 0 bytes; request ${JSON.stringify(hbBody).length} bytes`;
  });

  await check('policy change reaches a running agent in one heartbeat cycle', async () => {
    const cfg = await http('GET', '/api/v1/config', { headers: bearer(approved.token) });
    const beforeEtag = cfg.headers.etag;
    const put = await http('PUT', '/api/policy', {
      body: { changed: { screenshot_interval_minutes: 1 } }, headers: adminHeaders(),
    });
    assert(put.status === 200, `policy PUT ${put.status} ${JSON.stringify(put.json)}`);
    const hb = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: beforeEtag, spool_bytes: 1234, spool_dropped: 0, bytes_sent: 99 },
      headers: bearer(approved.token),
    });
    assert(hb.status === 200, `expected 200 got ${hb.status}`);
    assert(hb.json.changed?.screenshot_interval_minutes === 1, `delta was ${JSON.stringify(hb.json)}`);
    // The delta must be a delta: an agent holding a known etag never receives the whole document.
    const keys = Object.keys(hb.json.changed);
    assert(keys.length === 1, `server sent ${keys.length} keys instead of one changed key`);
    const newEtag = hb.headers['x-policy-etag'];
    assert(newEtag && newEtag !== beforeEtag, 'no new etag offered');
    const ack = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: newEtag, spool_bytes: 1234, spool_dropped: 0, bytes_sent: 99 },
      headers: bearer(approved.token),
    });
    assert(ack.status === 204, `ack heartbeat expected 204 got ${ack.status}`);
    const devices = await http('GET', '/api/devices', { headers: adminHeaders() });
    const me = devices.json.items.find((d) => d.id === approved.deviceId);
    assert(me.policy_etag === newEtag, 'collector did not record the acked etag');
    return `5 → 1 delivered as a ${JSON.stringify(hb.json).length}-byte single-key delta, then 204 on ack`;
  });

  await check('out-of-bounds and non-agent policy values are refused', async () => {
    const zero = await http('PUT', '/api/policy', {
      body: { changed: { screenshot_interval_minutes: 0 } }, headers: adminHeaders(),
    });
    assert(zero.status === 400, `0 minutes expected 400 got ${zero.status}`);
    const bind = await http('PUT', '/api/policy', {
      body: { changed: { collector_bind: '1.2.3.4' } }, headers: adminHeaders(),
    });
    assert(bind.status === 400, 'collector_bind must not be writable');
    const unknown = await http('PUT', '/api/policy', {
      body: { changed: { not_a_policy_key: 1 } }, headers: adminHeaders(),
    });
    assert(unknown.status === 400, 'unknown key must be refused');
    return 'interval 0, read-only collector_bind and an unknown key all rejected';
  });

  console.log('\nBatch ingest + idempotency');
  await check('a mixed batch reports accepted/duplicates/malformed/unknown', async () => {
    const ts = now();
    const lines = [
      { event_id: crypto.randomUUID(), type: 'screen_state', device_id: approved.deviceId, ts, data: { sampled_at: ts, state: 'active' } },
      { event_id: crypto.randomUUID(), type: 'extension_inventory', device_id: approved.deviceId, ts, data: { collected_at: ts, browser: 'chrome', profile: 'Default', extensions: [{ ext_id: 'abcdefghijklmnopabcdefghijklmnopabcdef', name: 'Test Ext', version: '1.0', source: 'webstore', permissions: ['tabs'], enabled: true }] } },
      'this is not json at all',
      { event_id: crypto.randomUUID(), type: 'some_future_type', device_id: approved.deviceId, ts, data: {} },
      { event_id: crypto.randomUUID(), type: 'clipboard_metric', device_id: approved.deviceId, ts, data: clipData(9) },
    ];
    const body = gzipSync(Buffer.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')));
    const r = await http('POST', '/api/v1/batch', {
      raw: true, body,
      headers: { ...bearer(approved.token), 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson', 'content-length': body.length },
    });
    assert(r.status === 200, `batch ${r.status} ${r.buf.toString().slice(0, 200)}`);
    const c = r.json;
    assert(c.malformed === 1, `malformed was ${c.malformed} (one non-JSON line)`);
    assert(c.unknown_types === 1, `unknown_types was ${c.unknown_types}`);
    assert(c.accepted === 3, `accepted was ${c.accepted}`);
    assert(c.accepted + c.duplicates + c.malformed + c.unknown_types === lines.length,
      `counts ${JSON.stringify(c)} do not add up to ${lines.length} lines`);
    return JSON.stringify(c);
  });

  await check('one inventory event carrying several extensions stores one row each', async () => {
    // Regression: extension_inventory once carried UNIQUE(event_id), so a profile with two
    // extensions violated it on its first submission and rolled the whole batch back with a 500.
    const ts = now();
    const eventId = crypto.randomUUID();
    const ids = ['aaaabbbbccccddddeeeeffff0000111122223333', 'aaaabbbbccccddddeeeeffff0000111122223334',
      'aaaabbbbccccddddeeeeffff0000111122223335'];
    const line = {
      event_id: eventId, type: 'extension_inventory', device_id: approved.deviceId, ts,
      data: {
        collected_at: ts, browser: 'chrome', profile: 'Regression',
        extensions: ids.map((id, i) => ({
          ext_id: id, name: `Ext ${i}`, version: `1.${i}`, source: 'webstore',
          permissions: i === 0 ? ['tabs', 'storage'] : [], enabled: i !== 1,
        })),
      },
    };
    const body = gzipSync(Buffer.from(JSON.stringify(line)));
    const headers = { ...bearer(approved.token), 'content-encoding': 'gzip',
      'content-type': 'application/x-ndjson', 'content-length': body.length };
    const r = await http('POST', '/api/v1/batch', { raw: true, body, headers });
    assert(r.status === 200, `batch ${r.status} ${r.buf.toString().slice(0, 200)}`);
    assert(r.json.accepted === 1 && r.json.malformed === 0, `first pass ${JSON.stringify(r.json)}`);
    const list = await http('GET', `/api/extensions?device=${approved.deviceId}&limit=200`,
      { headers: adminHeaders() });
    const rows = list.json.items.filter((e) => ids.includes(e.ext_id));
    assert(rows.length === 3, `expected 3 rows for one event, got ${rows.length}`);
    assert(new Set(rows.map((e) => e.event_id)).size === 1, 'the three rows must share one event_id');
    const again = await http('POST', '/api/v1/batch', { raw: true, body, headers });
    assert(again.json.duplicates === 1 && again.json.accepted === 0, `re-delivery ${JSON.stringify(again.json)}`);
    const after = await http('GET', `/api/extensions?device=${approved.deviceId}&limit=200`,
      { headers: adminHeaders() });
    const still = after.json.items.filter((e) => ids.includes(e.ext_id));
    assert(still.length === 3, `re-delivery must not add rows, got ${still.length}`);
    return '3 rows from 1 event, idempotent on re-delivery';
  });

  await check('re-sending the same batch reports duplicates and writes nothing new', async () => {
    const ts = now();
    const lines = [
      { event_id: '11111111-1111-4111-8111-111111111111', type: 'screen_state', device_id: approved.deviceId, ts, data: { sampled_at: ts, state: 'idle' } },
      { event_id: '22222222-2222-4222-8222-222222222222', type: 'screen_state', device_id: approved.deviceId, ts, data: { sampled_at: ts, state: 'locked' } },
    ];
    const body = gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')));
    const headers = { ...bearer(approved.token), 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson', 'content-length': body.length };
    const a = await http('POST', '/api/v1/batch', { raw: true, body, headers });
    const b = await http('POST', '/api/v1/batch', { raw: true, body, headers });
    assert(a.json.accepted === 2, `first pass accepted ${a.json.accepted}`);
    assert(b.json.duplicates === 2 && b.json.accepted === 0, `second pass ${JSON.stringify(b.json)}`);
    return 'at-least-once delivery is lossless';
  });

  await check('a batch with no gzip encoding is refused', async () => {
    const body = Buffer.from('{}\n');
    const r = await http('POST', '/api/v1/batch', {
      raw: true, body,
      headers: { ...bearer(approved.token), 'content-type': 'application/x-ndjson', 'content-length': body.length },
    });
    assert(r.status === 415, `expected 415 got ${r.status}`);
    return '415 unsupported_media';
  });

  await check('oversized batch body is rejected with 413, not buffered', async () => {
    // 6 MiB of incompressible-ish data behind a small gzip body: the cap has to be enforced on
    // the inflated stream, which is the only one that can be used to exhaust memory.
    const filler = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < filler.length; i += 7) filler[i] = (i * 31 + (i >> 3)) & 0xff;
    const body = gzipSync(filler, { level: 6 });
    const r = await httpExpectRefused('POST', '/api/v1/batch', {
      raw: true, body,
      headers: { ...bearer(approved.token), 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson', 'content-length': body.length },
    });
    assert(r.status === 413,
      `expected 413 got ${r.status}${r.socketError ? ` (${r.socketError}: the status never reached the client)` : ` ${r.buf.toString().slice(0, 120)}`}`);
    // The collector must still be healthy after refusing it.
    const after = await http('GET', '/api/v1/notice');
    assert(after.status === 200, 'collector died after a 413');
    return `413 on a 6 MiB inflated body (compressed ${(body.length / 1024).toFixed(0)} KiB), collector still serving`;
  });

  console.log('\nNotice version bump');
  await check('editing the wording at the same version keeps consent', async () => {
    const current = await getNoticeVersion();
    const r = await http('POST', '/api/policy/notice', {
      body: { version: current, text: 'Same version, corrected wording.\n<!-- NOTICE-BEGIN -->\nBody.\n<!-- NOTICE-END -->' },
      headers: adminHeaders(),
    });
    assert(r.status === 200, `wording edit ${r.status} ${JSON.stringify(r.json)}`);
    assert(r.json.returned_to_pending === 0,
      `same-version edit reset ${r.json.returned_to_pending} device(s); the Policy page promises it does not`);
    const devices = await http('GET', '/api/devices', { headers: adminHeaders() });
    const me = devices.json.items.find((d) => d.id === approved.deviceId);
    assert(me.state === 'approved', `state was ${me.state}`);
    const hb = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: 'x', spool_bytes: 0, spool_dropped: 0, bytes_sent: 0 },
      headers: bearer(approved.token),
    });
    assert(hb.status === 200, `ingest after same-version edit: ${hb.status} ${JSON.stringify(hb.json)}`);
    return `version ${current} kept, consent kept, heartbeat ${hb.status}`;
  });

  await check('bumping the notice version returns approved devices to pending and blocks ingest', async () => {
    const bumped = `${await getNoticeVersion()}-bumped`;
    const bump = await http('POST', '/api/policy/notice', {
      body: { version: bumped, text: 'Updated wording for the acceptance test.\n<!-- NOTICE-BEGIN -->\nBody.\n<!-- NOTICE-END -->' },
      headers: adminHeaders(),
    });
    assert(bump.status === 200, `bump ${bump.status} ${JSON.stringify(bump.json)}`);
    assert(bump.json.returned_to_pending >= 1, 'no devices returned to pending');
    noticeVersionCache = null;
    const r = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: 'x', spool_bytes: 0, spool_dropped: 0, bytes_sent: 0 },
      headers: bearer(approved.token),
    });
    assert(r.status === 403, `expected 403 got ${r.status} ${JSON.stringify(r.json)}`);
    const devices = await http('GET', '/api/devices', { headers: adminHeaders() });
    const me = devices.json.items.find((d) => d.id === approved.deviceId);
    assert(me.state === 'pending_approval', `state was ${me.state}`);
    return `403 ${r.json.error}; ${bump.json.returned_to_pending} device(s) back to pending`;
  });

  await check('approval on the strength of an old acknowledgment is refused', async () => {
    const a = await approve(approved.deviceId);
    assert(a.status === 403 && a.json.error === 'notice_outdated',
      `expected 403 notice_outdated, got ${a.status} ${JSON.stringify(a.json)}`);
    return 'old consent cannot approve onto new wording';
  });

  await check('re-acknowledging on the new version restores the device', async () => {
    const e = await enroll('2'.repeat(64));
    assert(e.status === 202, `re-enroll ${e.status} ${JSON.stringify(e.json)}`);
    const a = await approve(approved.deviceId);
    assert(a.status === 200, `re-approve ${a.status} ${JSON.stringify(a.json)}`);
    const r = await http('POST', '/api/v1/clipboard-metric', { body: clipData(6), headers: bearer(approved.token) });
    assert(r.status === 201, `ingest after re-ack ${r.status}`);
    return 'approved + ingesting again on the new notice';
  });

  console.log('\nRevoke + audit + export');
  await check('revoke requires a reason and kills the token', async () => {
    const noReason = await http('POST', `/api/devices/${approved.deviceId}/revoke`, {
      body: { reason: '  ' }, headers: adminHeaders(),
    });
    assert(noReason.status === 400, `blank reason got ${noReason.status}`);
    const rev = await http('POST', `/api/devices/${approved.deviceId}/revoke`, {
      body: { reason: 'acceptance: revocation path' }, headers: adminHeaders(),
    });
    assert(rev.status === 200, `revoke ${rev.status}`);
    const hb = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: 'x', spool_bytes: 0, spool_dropped: 0, bytes_sent: 0 },
      headers: bearer(approved.token),
    });
    assert(hb.status === 401, `revoked token expected 401 got ${hb.status}`);
    return '400 without a reason; a revoked token no longer authenticates';
  });

  await check('a revoked device cannot be un-revoked by a direct state update', async () => {
    // The guard is a DB trigger; prove it with an in-process copy of the schema.
    const mem = new DatabaseSync(':memory:');
    mem.exec(readFileSync(path.join(ROOT, 'server', 'lib', 'schema.sql'), 'utf8'));
    const id = crypto.randomUUID();
    mem.prepare(`INSERT INTO devices (id, fingerprint, hostname, os_build, device_user,
        agent_version, enrolled_at, notice_version, acknowledged_by, acknowledged_at, state,
        revoked_by, revoked_at, revoke_reason)
      VALUES (?, ?, 'H', '10.0', 'u', '1.0', datetime('now'), 'v1', 'N', datetime('now'),
        'revoked', 'admin', datetime('now'), 'reason')`)
      .run(id, 'f'.repeat(64));
    let msg = null;
    try { mem.prepare('UPDATE devices SET state = ? WHERE id = ?').run('approved', id); }
    catch (err) { msg = err.message; }
    assert(msg, 'a revoked row was approvable by direct UPDATE');
    mem.close();
    return `blocked: ${msg.split('\n')[0]}`;
  });

  await check('reenable clears revoked but does not carry consent over', async () => {
    const r = await http('POST', `/api/devices/${approved.deviceId}/reenable`, {
      body: {}, headers: adminHeaders(),
    });
    assert(r.status === 200 && r.json.requires_reacknowledgment === true, `${r.status} ${JSON.stringify(r.json)}`);
    const a = await approve(approved.deviceId);
    assert(a.status !== 200, 'a re-enabled device was approvable without a fresh acknowledgment');
    return `state ${r.json.state}; approval refused (${a.json?.error ?? a.status})`;
  });

  await check('every admin mutation requires a CSRF token', async () => {
    const get = await http('GET', '/api/devices', { headers: { cookie: cookie ?? '' } });
    assert(get.status === 200, 'GET should be allowed without csrf');
    const r = await http('POST', `/api/devices/${approved.deviceId}/approve`, { body: {}, headers: { cookie: cookie ?? '' } });
    assert(r.status === 403 && r.json.error === 'csrf_failed', `expected csrf_failed got ${r.status} ${JSON.stringify(r.json)}`);
    const wrong = await http('POST', `/api/devices/${approved.deviceId}/approve`, {
      body: {}, headers: { cookie: cookie ?? '', 'x-csrf-token': '0'.repeat(32) },
    });
    assert(wrong.status === 403, `a forged token got ${wrong.status}`);
    return 'POST without and with a forged X-CSRF-Token both refused';
  });

  await check('media route is behind the session and the store is not statically reachable', async () => {
    const list = await http('GET', '/api/screenshots', { headers: adminHeaders() });
    const id = list.json.items[0]?.id;
    assert(id, 'no screenshots to test with');
    const anon = await http('GET', `/media/screenshots/${id}`);
    assert(anon.status === 401, `anonymous expected 401 got ${anon.status}`);
    const asUser = await http('GET', `/media/screenshots/${id}`, { headers: { cookie: cookie ?? '' } });
    assert(asUser.status === 200 && asUser.buf.subarray(1, 4).toString('latin1') === 'PNG',
      `expected a PNG back, got ${asUser.status}`);
    const revalidated = await http('GET', `/media/screenshots/${id}`, {
      headers: { cookie: cookie ?? '', 'if-none-match': asUser.headers.etag },
    });
    assert(revalidated.status === 304 && revalidated.buf.length === 0, `revalidate ${revalidated.status}`);
    for (const guess of ['/screenshots/latest.png', '/media/screenshots', `/data/screenshots/${id}.png`]) {
      const r = await http('GET', guess);
      assert([401, 404].includes(r.status), `${guess} returned ${r.status}`);
    }
    return 'session-gated, 304 on revalidation, no static path into the store';
  });

  await check('login failures are rate-limited and audited', async () => {
    let last = null;
    for (let i = 0; i < 6; i++) {
      last = await http('POST', '/api/login', { body: { account: 'nosuchuser', password: 'wrong' } });
    }
    assert(last.status === 429, `6th failure expected 429 got ${last.status}`);
    const audit = await http('GET', '/api/audit?limit=50', { headers: adminHeaders() });
    const fails = audit.json.items.filter((a) => a.action === 'login_failed');
    assert(fails.length >= 5, `only ${fails.length} login_failed rows`);
    assert(!JSON.stringify(fails).includes('acceptance-pass-42'), 'a password reached the audit log');
    return `429 after 5 failures, ${fails.length} audit rows, no credentials in them`;
  });

  await check('telemetry health reports spool depth, drops, stale etag and flush', async () => {
    const r = await http('GET', '/api/telemetry-health', { headers: adminHeaders() });
    assert(r.status === 200, `health ${r.status}`);
    const me = r.json.devices.find((d) => d.id === approved.deviceId);
    assert(me, 'device missing from health view');
    for (const key of ['spool_bytes', 'spool_dropped', 'policy_stale', 'last_flush_ms', 'bytes_last_hour']) {
      assert(key in me, `missing field ${key}`);
    }
    assert(me.last_flush_ms !== null, 'a batch was flushed but no duration was recorded');
    return JSON.stringify({ stale: me.policy_stale, dropped: me.spool_dropped, flush_ms: me.last_flush_ms });
  });

  await check('export writes an audit row and contains no clipboard text field', async () => {
    const r = await http('POST', `/api/export/${approved.deviceId}`, { body: {}, headers: adminHeaders() });
    assert(r.status === 200, `export ${r.status}`);
    const text = r.buf.toString('utf8');
    for (const forbidden of ['"content":', '"text":', 'storage_key', 'token_hash', 'fingerprint']) {
      assert(!text.includes(forbidden), `export contained ${forbidden}`);
    }
    const audit = await http('GET', '/api/audit?limit=10', { headers: adminHeaders() });
    assert(audit.json.items.some((a) => a.action === 'data_export'), 'export was not audited');
    return `${r.buf.length} bytes exported + audited; no content/storage_key/token fields`;
  });

  await check('devices list never exposes the fingerprint or token hash', async () => {
    const r = await http('GET', '/api/devices', { headers: adminHeaders() });
    const blob = JSON.stringify(r.json.items);
    assert(!blob.includes('token_hash'), 'token_hash leaked in the device list');
    assert(!blob.includes(`${'2'.repeat(64)}`), 'device fingerprint leaked in the device list');
    return `${r.json.items.length} rows, no secrets`;
  });

  console.log('\nRound-trip confirmation');

  // The brief says the server must confirm a registered client and that it works. `state` alone
  // cannot: an approved device whose agent never calls in looks identical to one uploading every
  // minute. These checks walk a fresh device through the five stamps in the order an agent really
  // produces them and assert the verdict moves at each step.
  await check('the collector reports the round trip in the order the agent produces it', async () => {
    const fp = '7'.repeat(64);
    const verify = async () => {
      const r = await http('GET', `/api/devices/${deviceId}/verify`, { headers: adminHeaders() });
      assert(r.status === 200, `verify ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const step = (body, key) => body.steps.find((s) => s.key === key);

    const e = await enroll(fp, { hostname: 'ROUNDTRIP-BOX' });
    assert(e.status === 202, `enroll got ${e.status}`);
    const deviceId = e.json.device_id;
    let v = await verify();
    assert(v.verdict === 'awaiting_approval', `fresh device verdict was ${v.verdict}`);
    assert(step(v, 'acknowledged').done && !step(v, 'approved').done, 'consent stamps wrong');

    const a = await approve(deviceId);
    assert(a.status === 200, `approve got ${a.status}`);
    v = await verify();
    assert(v.verdict === 'token_pending', `after approval verdict was ${v.verdict}`);

    const s = await http('GET', `/api/v1/enroll/status?fingerprint=${fp}`);
    assert(s.json.token, 'no token delivered on approval');
    v = await verify();
    assert(v.verdict === 'no_contact', `after token delivery verdict was ${v.verdict}`);
    assert(step(v, 'token').done, 'token stamp did not move when the agent collected it');

    const hb = await http('POST', '/api/v1/heartbeat', {
      body: { policy_etag: 'x', spool_bytes: 0, spool_dropped: 0, bytes_sent: 0, agent_version: '1.0.0' },
      headers: bearer(s.json.token),
    });
    assert(hb.status === 200 || hb.status === 204, `heartbeat got ${hb.status}`);
    v = await verify();
    assert(v.verdict === 'no_data', `after the first call home verdict was ${v.verdict}`);

    const ts = now();
    const lines = [{ event_id: crypto.randomUUID(), type: 'screen_state', device_id: deviceId,
      ts, data: { sampled_at: ts, state: 'active' } }];
    const body = gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')));
    const batch = await http('POST', '/api/v1/batch', {
      raw: true, body,
      headers: { ...bearer(s.json.token), 'content-encoding': 'gzip',
        'content-type': 'application/x-ndjson', 'content-length': body.length },
    });
    assert(batch.status === 200, `batch got ${batch.status}`);
    v = await verify();
    assert(v.working === true, `after accepted data verdict was ${v.verdict}: ${v.detail}`);
    assert(step(v, 'data').done, 'data stamp did not move when the collector accepted a row');
    return `${v.headline} — five stamps, each moved by the step that owns it`;
  });

  await check('a re-approval restarts the round trip instead of inheriting the old verdict', async () => {
    const r = await http('GET', '/api/devices', { headers: adminHeaders() });
    const target = r.json.items.find((d) => d.hostname === 'ROUNDTRIP-BOX');
    assert(target, 'the round-trip device disappeared from the list');
    assert(target.verification?.verdict === 'working',
      `list verdict was ${target.verification?.verdict}, expected the same verdict /verify gives`);
    const rev = await http('POST', `/api/devices/${target.id}/revoke`,
      { body: { reason: 'rotation test' }, headers: adminHeaders() });
    assert(rev.status === 200, `revoke got ${rev.status}`);
    const re = await http('POST', `/api/devices/${target.id}/reenable`, { body: {}, headers: adminHeaders() });
    assert(re.status === 200, `reenable got ${re.status}`);
    // datetime('now') is second-resolution and consent must be strictly later than the revocation,
    // so acknowledging in the same second is correctly refused. Wait for the next one.
    await sleep(1200);
    await enroll('7'.repeat(64), { hostname: 'ROUNDTRIP-BOX' });
    const a = await approve(target.id);
    assert(a.status === 200, `re-approve got ${a.status} ${JSON.stringify(a.json)}`);
    const after = await http('GET', `/api/devices/${target.id}/verify`, { headers: adminHeaders() });
    assert(['token_pending', 'awaiting_approval'].includes(after.json.verdict),
      `a re-approved device still reported ${after.json.verdict} — old stamps were inherited`);
    return `verdict reset to ${after.json.verdict} on the new approval`;
  });

  await check('the devices list and the dashboard render the same verdict', async () => {
    const list = await http('GET', '/api/devices', { headers: adminHeaders() });
    const row = list.json.items.find((d) => d.hostname === 'ROUNDTRIP-BOX');
    assert(row?.verification, 'the list carries no verification object');
    const detail = await http('GET', `/api/devices/${row.id}`, { headers: adminHeaders() });
    assert(detail.json.verification.verdict === row.verification.verdict,
      `list says ${row.verification.verdict}, detail says ${detail.json.verification.verdict}`);
    const page = await http('GET', '/', { headers: { cookie: cookie ?? '' } });
    assert(page.status === 200, `overview page got ${page.status}`);
    const html = page.buf.toString('utf8');
    assert(html.includes('chip-'), 'the overview rendered no status chip');
    assert(html.includes('Getting a device collecting') || row.verification.verdict === 'working',
      'neither the first-run checklist nor a working device was on the page');
    return `${row.verification.verdict} identical in list, detail and HTML`;
  });

  await stopCollector();

  console.log('\nFirst-run account claim');

  // A fresh collector has no credential anywhere in its tree. That is deliberate, but it used to
  // mean the only way in was a console command on the right box with the right database path. The
  // claim form is the same proof made usable: a random per-installation code that exists only while
  // the account table is empty, and only on that collector's own disk.
  await check('an empty collector prints a first-run code and offers a claim form, not a login', async () => {
    const started = await startCollector({ CTTIme_BOOTSTRAP_ACCOUNT: '' });
    assert(started.port > 0, 'collector did not report a port');
    const boot = child.__lines.join('');
    assert(/first-run code\s+[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}/.test(boot),
      `boot output carried no first-run code:\n${boot.slice(-400)}`);
    const status = await http('GET', '/api/account-status');
    assert(status.status === 200 && status.json.accounts === 0 && status.json.claimable === true,
      `account-status said ${JSON.stringify(status.json)}`);
    const page = await http('GET', '/login');
    const html = page.buf.toString('utf8');
    assert(html.includes('Create the first administrator'), 'the login page did not switch to the claim form');
    assert(html.includes('data-action="claim"'), 'the page carries no claim form to submit');
    assert(!html.includes('data-action="login"'), 'a sign-in form was offered with no account to sign in to');
    assert(!/acceptance-pass|claimed-pass/.test(boot), 'a password appeared in the collector boot output');
    return 'first-run code printed at boot, /login offers the claim form only';
  });

  await check('the claim is refused without the code, and a wrong code is audited and rate-limited', async () => {
    const bad = await http('POST', '/api/claim', {
      body: { account: 'itadmin', password: 'claimed-pass-1234', code: 'WRONG-WRONG-WRONG' },
    });
    assert(bad.status === 403 && bad.json.error === 'bad_setup_code',
      `wrong code got ${bad.status} ${JSON.stringify(bad.json)}`);
    const weak = await http('POST', '/api/claim', {
      body: { account: 'itadmin', password: 'short', code: 'AAAAA-AAAAA-AAAAA' },
    });
    assert(weak.status === 400, `a 5-character password got ${weak.status}`);
    const audit = await http('GET', '/api/audit', { headers: adminHeaders() });
    assert(audit.status === 401, 'the audit list was readable without a session');
    const rows = child.__lines.join('');
    assert(!/claimed-pass|WRONG/.test(rows), 'a claimed password or code appeared in the collector log');
    return '403 on a wrong code, 400 on a weak password, nothing sensitive logged';
  });

  await check('the code claims the account, signs the operator in, and deletes itself', async () => {
    const codeFile = path.join(TMP, 'server-data', 'first-run-code.txt');
    assert(existsSync(codeFile), 'the collector never wrote first-run-code.txt');
    const code = readFileSync(codeFile, 'utf8').trim();
    const lower = await http('POST', '/api/claim', {
      body: { account: 'itadmin', password: 'claimed-pass-1234', code: code.toLowerCase().replace(/(.{5})(?=.)/g, '$1-') },
    });
    assert(lower.status === 201, `claim got ${lower.status} ${JSON.stringify(lower.json)}`);
    assert(lower.json.csrf && lower.headers['set-cookie']?.[0], 'the claim did not return a session');
    csrf = lower.json.csrf;
    cookie = lower.headers['set-cookie'][0].split(';')[0];
    const devices = await http('GET', '/api/devices', { headers: adminHeaders() });
    assert(devices.status === 200, `the claimed account could not use the API (${devices.status})`);
    assert(!existsSync(codeFile), 'first-run-code.txt survived the first account');
    const status = await http('GET', '/api/account-status');
    assert(status.json.accounts === 1 && status.json.claimable === false,
      `account-status after the claim: ${JSON.stringify(status.json)}`);
    const again = await http('POST', '/api/claim', {
      body: { account: 'second', password: 'another-pass-1234', code },
    });
    assert(again.status === 409, `a second claim got ${again.status}, expected 409`);
    const login = await http('POST', '/api/login', {
      body: { account: 'itadmin', password: 'claimed-pass-1234' },
    });
    assert(login.status === 200, `signing in with the claimed passphrase got ${login.status}`);
    const page = await http('GET', '/login');
    assert(!page.buf.toString('utf8').includes('Create the first administrator'),
      'the claim form is still on offer after an account exists');
    return 'claimed by code, code file gone, second claim refused, login works';
  });

  await stopCollector();

  console.log('\nAgent-side behaviour');
  await check('spool appends are O(1) and roll into segments', async () => {
    const { createSpool } = await import('../agent/lib/spool.js');
    const dir = path.join(TMP, 'spool-roll');
    const rollAt = 16 * 1024;
    const spool = createSpool({ dir, maxBytes: 64 * 1024 * 1024, segmentBytes: rollAt });
    for (let i = 0; i < 400; i++) {
      spool.append({
        event_id: crypto.randomUUID(), type: 'screen_state', device_id: 'x', ts: now(),
        data: { sampled_at: now(), state: i % 3 === 0 ? 'idle' : 'active', pad: 'y'.repeat(400) },
      });
    }
    const segs = readdirSync(dir).filter((f) => /^events-\d+\.jsonl$/.test(f));
    const sizes = segs.map((f) => statSync(path.join(dir, f)).size);
    assert(segs.length >= 7, `expected the log to roll into several segments, got ${segs.length}`);
    assert(sizes.every((s) => s <= rollAt + 1024), `a segment exceeded its roll budget: ${Math.max(...sizes)}`);
    const drained = spool.takeBatch(100000, 64 * 1024 * 1024);
    assert(drained.events.length === 400, `expected 400 events back, got ${drained.events.length}`);
    assert(drained.files.every((f) => /^events-\d+\.jsonl$/.test(path.basename(f.file))),
      'takeBatch returned something that is not a segment');
    spool.close();
    return `${segs.length} segments of ≤${rollAt}b, all 400 events read back`;
  });

  await check('collector outage: spool stays under cap, oldest evicted, drops reported', async () => {
    const { createSpool } = await import('../agent/lib/spool.js');
    const dir = path.join(TMP, 'spool-cap');
    const cap = 24 * 1024;
    const spool = createSpool({ dir, maxBytes: cap, segmentBytes: 4096 });
    for (let i = 0; i < 600; i++) {
      spool.append({
        event_id: crypto.randomUUID(), type: 'clipboard_metric', device_id: 'x', ts: now(),
        data: { ...clipData(i), pad: 'z'.repeat(200) },
      });
    }
    const t = spool.totals();
    assert(t.bytes <= cap, `spool grew to ${t.bytes} over a ${cap} cap`);
    const dropped = spool.dropped();
    assert(dropped > 0, 'nothing was reported as dropped');
    const remaining = spool.takeBatch(100000, 10 * 1024 * 1024).events;
    assert(remaining.length < 600, 'no data was actually dropped');
    const seqs = remaining.map((e) => e.data.char_count);
    assert(Math.min(...seqs) > 0, 'eviction removed the newest events instead of the oldest');
    // Reported once, then cleared, so a gap is counted exactly once by the heartbeat.
    assert(spool.acknowledgeDropped() === dropped, 'dropped counter did not match');
    assert(spool.acknowledgeDropped() === 0, 'dropped counter was not cleared after reporting');
    spool.close();
    return `cap ${cap} held at ${t.bytes}b; ${dropped} events dropped, oldest-first, reported once (${remaining.length} kept)`;
  });

  await check('a screenshot blob over the cap is dropped locally, not sent', async () => {
    const { createSpool } = await import('../agent/lib/spool.js');
    const dir = path.join(TMP, 'spool-blob');
    rmSync(dir, { recursive: true, force: true });
    const spool = createSpool({ dir, maxBytes: 1024 * 1024, segmentBytes: 4096 });
    spool.writeBlob(`${crypto.randomUUID()}.png`, Buffer.alloc(700 * 1024, 7));
    spool.close();
    const { createTransport } = await import('../agent/lib/transport.js');
    const { createFlusher } = await import('../agent/lib/flush.js');
    const transport = createTransport({ host: '127.0.0.1', port: 1, pin: '0'.repeat(64) });
    const flusher = createFlusher({
      transport, spool: createSpool({ dir, maxBytes: 1024 * 1024, segmentBytes: 4096 }),
      policy: { values: { screenshot_max_bytes: 8 * 1024 * 1024, batch_max_items: 200, batch_max_bytes: 262144 } },
      deviceId: () => 'x', token: { headers: () => ({}) }, log: () => {}, onPolicy: () => {},
    });
    const out = await flusher.flushScreenshots();
    assert(out.uploaded === 0, `a 700 KiB blob was uploaded to a dead collector (${out.uploaded})`);
    return 'blob gated by policy size before the socket is touched';
  });

  await check('spool files on disk contain no clipboard text', async () => {
    const dir = path.join(TMP, 'spool-privacy');
    rmSync(dir, { recursive: true, force: true });
    const secret = 'hunter2-this-is-clipboard-content';
    const { createSpool } = await import('../agent/lib/spool.js');
    const spool = createSpool({ dir, maxBytes: 1024 * 1024, segmentBytes: 4096 });
    // Exactly the event producers.js builds: the content is hashed and never handed to the spool.
    spool.append({
      event_id: crypto.randomUUID(), type: 'clipboard_metric', device_id: 'x', ts: now(),
      data: {
        sampled_at: now(), char_count: secret.length,
        sha256: createHash('sha256').update(secret).digest('hex'), content_kind: 'text',
      },
    });
    spool.close();
    const all = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8')).join('');
    assert(all.includes(createHash('sha256').update(secret).digest('hex')), 'hash missing; writer may not be recording');
    assert(!all.includes(secret), 'clipboard text was found in the spool');
    return 'hash present, text absent';
  });

  await check('the clipboard sampler returns only count/hash/kind', async () => {
    const { createClipboardSampler, EMPTY_HASH } = await import('../agent/lib/clipboard.js');
    const sample = createClipboardSampler({ workDir: path.join(TMP, 'clip') });
    const got = await sample();
    assert(got, 'sampler returned nothing (see the agent log for the probe failure)');
    const keys = Object.keys(got).sort().join(',');
    assert(keys === 'char_count,content_kind,sha256', `unexpected keys ${keys}`);
    assert(/^[0-9a-f]{64}$/.test(got.sha256), `bad hash ${got.sha256}`);
    if (got.char_count === 0) assert(got.sha256 === EMPTY_HASH, 'empty clipboard hashed wrong');
    assert(got.sha256 !== '0'.repeat(64), 'sampler returned a placeholder hash');
    return JSON.stringify(got);
  });

  await check('backoff is full-jittered and capped at the two-minute reconnect ceiling', async () => {
    const { backoffDelay } = await import('../agent/lib/producers.js');
    // The defaults are what flush.js calls, so a change to the ceiling is a change to the device.
    const at = (n) => Array.from({ length: 200 }, () => backoffDelay(n));
    const s0 = at(0); const s5 = at(5); const s20 = at(20);
    assert(Math.max(...s0) <= 2000, `attempt 0 exceeded the 2s base: ${Math.max(...s0)}`);
    assert(Math.min(...s0) >= 0, 'negative delay');
    assert(Math.max(...s5) <= 64000, `attempt 5 exceeded 2s*2^5: ${Math.max(...s5)}`);
    assert(Math.max(...s20) <= 120000, `cap exceeded: ${Math.max(...s20)}`);
    const spread = new Set(at(6).map((d) => Math.floor(d / 1000))).size;
    assert(spread > 8, `delays look deterministic (only ${spread} distinct seconds)`);
    return `attempt 0 max ${Math.max(...s0)}ms, capped max ${Math.max(...s20)}ms, ${spread} distinct values at attempt 6`;
  });

  await check('extension parsers handle synthetic profiles, missing dirs and absent keys', async () => {
    const fixtures = path.join(TMP, 'fixtures');
    writeBrowserFixtures(fixtures);
    const { readExtensionInventory } = await import('../agent/lib/extensions.js');
    const found = readExtensionInventory({ localAppData: fixtures, appData: fixtures, rootOverride: fixtures });
    assert(found.length >= 3, `expected chrome+edge+firefox profiles, got ${found.length}`);
    const chrome = found.find((f) => f.browser === 'chrome' && f.profile === 'Default');
    assert(chrome, 'no chrome Default profile parsed');
    const ext = chrome.extensions.find((e) => e.ext_id === 'chromeExtId11111111111111111111');
    assert(ext, 'chrome extension not mapped');
    assert(ext.name === 'Acceptance Extension' && ext.enabled === true, JSON.stringify(ext));
    assert(ext.permissions.includes('tabs'), `permissions were ${JSON.stringify(ext.permissions)}`);
    const ff = found.find((f) => f.browser === 'firefox');
    assert(ff && ff.extensions.some((e) => e.ext_id === 'acceptance@extension.test'), 'firefox parse failed');
    const edge = found.find((f) => f.browser === 'edge');
    assert(edge && edge.extensions[0].source === 'sideload', 'edge sideload detection failed');
    const disabled = found.flatMap((f) => f.extensions).filter((e) => e.enabled === false);
    assert(disabled.length >= 2, `expected a disabled chrome and firefox ext, got ${disabled.length}`);
    assert(!found.flatMap((f) => f.extensions).some((e) => e.ext_id === 'nmmhkkegccagdldgiimedpiccmgmieda'),
      'a browser-shipped extension was reported as installed');
    const noName = chrome.extensions.find((e) => e.ext_id.startsWith('malformedEntry'));
    assert(noName && noName.name === noName.ext_id, 'an entry with no name should fall back to its id');
    // Corrupt and keyless profiles contribute nothing but must not remove the good ones.
    assert(!found.some((f) => f.browser === 'brave'), 'a corrupt Brave profile produced a row');
    assert(!found.some((f) => f.profile === 'Profile 2'), 'a profile with no extension key produced a row');
    const gistBefore = found.map((f) => f.gist).join();
    assert(found.every((f) => /^[0-9.]+\|\d+\|[0-9a-f]{64}$/.test(f.gist)), 'a profile has no file gate hash');
    const again = readExtensionInventory({ localAppData: fixtures, appData: fixtures, rootOverride: fixtures });
    assert(again.map((f) => f.gist).join() === gistBefore, 'gist is not deterministic for the same bytes');
    const count = found.reduce((n, f) => n + f.extensions.length, 0);
    return `${found.length} profiles, ${count} extensions, corrupt + keyless profiles skipped`;
  });

  await check('absent browsers produce no crash and no rows', async () => {
    const { readExtensionInventory } = await import('../agent/lib/extensions.js');
    const empty = path.join(TMP, 'fixtures-empty');
    mkdirSync(empty, { recursive: true });
    const found = readExtensionInventory({ localAppData: empty, appData: empty, rootOverride: empty });
    assert(Array.isArray(found) && found.length === 0, `got ${JSON.stringify(found)}`);
    const nowhere = path.join(TMP, 'does-not-exist');
    const second = readExtensionInventory({ localAppData: nowhere, appData: nowhere, rootOverride: nowhere });
    assert(second.length === 0, 'a nonexistent root produced rows');
    return 'graceful for empty and nonexistent roots';
  });

  await check('unchanged screen is deduped before upload; changed screen is not', async () => {
    const { phashFromPng, isUnchanged, hamming } = await import('../agent/lib/phash.js');
    const a = makePng(128, 96, 5);
    const b = makePng(128, 96, 5); // identical pixels, independently encoded
    const c = makePng(128, 96, 60); // clearly different
    const ha = phashFromPng(a); const hb = phashFromPng(b); const hc = phashFromPng(c);
    assert(ha && hb && hc, `phash returned null (${ha}/${hb}/${hc}) — decoder rejected the PNG`);
    assert(isUnchanged(ha, hb), 'identical frames were not treated as unchanged');
    assert(!isUnchanged(ha, hc), 'different frames were treated as unchanged');
    assert(hamming(ha, hc) > 0, `distinct screens hashed equal: ${ha}`);
    assert(hamming(ha, hb) === 0, 'identical screens differ');
    return `unchanged=${ha} changed=${hc} hamming ${hamming(ha, hc)}`;
  });

  await check('the unchanged-frame event carries no pixels', async () => {
    const { validateSkippedFrameData } = await import('../server/lib/validate.js');
    const v = validateSkippedFrameData({ captured_at: now(), sha256: '0'.repeat(64), phash: 'a09272b0b0b08081' });
    assert(v.ok, `skipped-frame event rejected: ${v.reason}`);
    const bad = validateSkippedFrameData({ captured_at: now(), png: 'aGVsbG8=' });
    assert(!bad.ok, 'an event with an embedded image was accepted');
    return 'only captured_at/sha256/phash survive validation';
  });

  await check('real capture on this host yields a decodable PNG and a state label', async () => {
    const { createCapturer } = await import('../agent/lib/screenshot.js');
    const { phashFromPng } = await import('../agent/lib/phash.js');
    const cap = createCapturer({ workDir: path.join(TMP, 'cap') });
    const r = await cap.capture({ idleSkipSeconds: 3600, skipWhenLocked: true });
    assert(['locked', 'idle', 'active'].includes(r.state), `unexpected state ${r.state}`);
    if (!r.captured) {
      return `skipped as ${r.state} (idle ${r.idleSeconds ?? '?'}s`
        + `${r.reason ? `, reason ${r.reason}` : ''}) — no pixels uploaded, which is the point`;
    }
    const phash = phashFromPng(r.png);
    assert(phash, 'capture produced a PNG the hash stage could not decode');
    assert(r.png.length < 8 * 1024 * 1024, 'capture exceeded the default max');
    const again = await cap.capture({ idleSkipSeconds: 3600, skipWhenLocked: true });
    const phash2 = again.captured ? phashFromPng(again.png) : null;
    const dedupe = phash2 ? `${phash === phash2 ? 'second frame deduped' : 'screen changed between captures'}` : 'second frame skipped';
    return `${r.width}x${r.height}, ${(r.png.length / 1024).toFixed(0)} KiB, phash ${phash}; ${dedupe}`;
  });

  await check('the idle probe survives a wrapped 32-bit tick counter', async () => {
    // Regression: LASTINPUTINFO.dwTime is a uint32 tick count that wraps at ~24.85 days of uptime.
    // The script used to subtract it as signed Int32 and repair the wrap with [int][uint32]::MaxValue
    // -- a conversion Windows PowerShell rejects outright. The throw landed in the script's single
    // outer catch, which sits *after* the capture block, so every long-uptime host silently stopped
    // sending screenshots while still reporting a healthy 'active' state.
    // The arithmetic is proven here against the C# inside the shipped script, not a copy of it.
    const { CAPTURE_SCRIPT } = await import('../agent/lib/screenshot.js');
    const { spawnSync } = await import('node:child_process');
    const block = /[$]idleSig = @'\r?\n([\s\S]*?)\r?\n'@/.exec(CAPTURE_SCRIPT);
    assert(block, 'no $idleSig type definition in the capture script — update this check with it');
    assert(/DeltaMillis/.test(block[1]),
      'the idle helper no longer computes the tick difference; the wrap case is untested');

    const cases = [
      { last: 1000, now: 61000, want: 60000 },            // ordinary, no wrap anywhere
      { last: 3000000000, now: 3000060000, want: 60000 },  // both sides past Int32 range
      { last: 4294900000, now: 50000, want: 117296 },      // last input before the wrap
      { last: 4294967096, now: 200, want: 400 },           // straddles the wrap by 400ms
    ];
    const file = path.join(TMP, 'idle-wrap-probe.ps1');
    writeFileSync(file, [
      `Add-Type -TypeDefinition @'`, block[1], `'@`,
      '$r = @{}',
      ...cases.map((c, i) => `$r['${i}'] = [Win]::DeltaMillis([uint32]${c.last}, [uint64]${c.now})`),
      `$r['live'] = [Win]::IdleMillis()`,
      '$r | ConvertTo-Json -Compress',
    ].join('\n'), 'utf8');

    const run = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', windowsHide: true });
    assert(run.status === 0, `probe script exited ${run.status}: ${(run.stderr || '').slice(0, 300)}`);
    const got = JSON.parse((run.stdout || '').trim());
    const wrong = cases
      .map((c, i) => ({ ...c, got: Number(got[String(i)]) }))
      .filter((c) => c.got !== c.want)
      .map((c) => `last=${c.last} now=${c.now} got ${c.got} want ${c.want}`);
    assert(wrong.length === 0, `wrap arithmetic wrong: ${wrong.join('; ')}`);
    // -1 is the documented "cannot determine" value; the caller treats it as idle-unknown and
    // captures anyway, so a probe that cannot answer cannot stop the recording.
    assert(Number(got.live) >= -1, `live IdleMillis returned ${got.live}`);
    return `${cases.length} tick pairs incl. both past Int32 range and 2 across the wrap; live=${got.live}ms`;
  });

  await check('every configured collector port answers, and an agent fails over to a live one', async () => {
    // Multi-port is availability, not identity: both listeners carry the same certificate and run
    // the same router, so a device whose first port is blocked by a local firewall rule still
    // reports, and a pin mismatch on the second port is still fatal.
    const { createTransport } = await import('../agent/lib/transport.js');
    const dataDir = path.join(TMP, 'multiport');
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const primary = 18443;
    const extra = 18444;
    const lines = [];
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env, CTTIme_PORT: String(primary), CTTIme_EXTRA_PORTS: String(extra),
        CTTIme_DB: path.join(dataDir, 'collector.db'),
        CTTIme_SHOTS: path.join(dataDir, 'screenshots'),
        CTTIme_DATA: dataDir,
        CTTIme_BOOTSTRAP_ACCOUNT: `${COLLECTOR_ACCOUNT}:${COLLECTOR_PASSWORD}`,
      },
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => lines.push(String(d)));
    proc.stderr.on('data', (d) => lines.push(`[stderr] ${String(d)}`));
    let boot = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const text = lines.join('');
      const cert = /cert SHA-256\s+([0-9a-f]{64})/.exec(text);
      const also = /also listening https:\/\/[\d.]+:(\d+)/.exec(text);
      if (cert && also) { boot = { pin: cert[1], extra: Number(also[1]) }; break; }
      if (/Error:|EADDRINUSE/.test(text)) throw new Error(`second collector failed to boot:\n${text}`);
      await sleep(120);
    }
    assert(boot, `collector never reported its second listener:\n${lines.join('')}`);
    const transports = [];
    try {
      const overPrimary = createTransport({ host: '127.0.0.1', port: primary, pin: boot.pin });
      const overExtra = createTransport({ host: '127.0.0.1', port: boot.extra, pin: boot.pin });
      transports.push(overPrimary, overExtra);
      const a = await overPrimary.get('/api/v1/notice');
      const b = await overExtra.get('/api/v1/notice');
      assert(a.status === 200 && b.status === 200, `notice returned ${a.status}/${b.status}`);
      assert(a.body.toString('utf8') === b.body.toString('utf8'),
        'the two listeners served different documents -- they are not the same collector');
      assert(overPrimary.pinVerified() && overExtra.pinVerified(),
        'a listener accepted a connection without comparing the pin');

      // Port 1 on loopback is refused by the OS rather than hanging, which is the case a device
      // meets when one port of the set is blocked.
      const failing = createTransport({ host: '127.0.0.1', ports: [1, boot.extra], pin: boot.pin });
      transports.push(failing);
      const c = await failing.get('/api/v1/notice');
      assert(c.status === 200, 'failover to the second port did not deliver the request');
      assert(failing.activePort() === boot.extra,
        `the transport stayed on port ${failing.activePort()} after a refused port`);

      // A wrong pin must not be answered by trying the next port: the same certificate is presented
      // on all of them, so a mismatch is a different machine, not a bad route.
      const hostile = createTransport({ host: '127.0.0.1', ports: [boot.extra, primary],
        pin: '0'.repeat(64) });
      transports.push(hostile);
      let refused = null;
      try { await hostile.get('/api/v1/notice'); } catch (err) { refused = err; }
      assert(refused && refused.code === 'tls_pin_mismatch',
        `a wrong pin over a port set produced ${refused?.code ?? 'no error'}`);
      return `: ${primary} and :${boot.extra} served the same notice; refused port failed over to :${boot.extra}`;
    } finally {
      for (const t of transports) { try { t.close(); } catch { /* already closed */ } }
      proc.kill();
      await sleep(250);
    }
  });

  await check('the device user is told when the link drops, returns, or cannot be verified', async () => {
    const { createConnectionWatch } = await import('../agent/lib/connection.js');
    const seen = [];
    const retries = [];
    const notifier = { show: (kind) => { seen.push(kind); return Promise.resolve({ shown: true }); } };
    let state = 'unknown';
    const watch = createConnectionWatch({
      notifier, log: () => {},
      onRetry: () => { retries.push(Date.now()); return Promise.resolve(); },
    });
    // Down: one notice, and a retry scheduled well inside the old 15-minute ceiling.
    watch.observe({ retryInMs: 500000 });
    assert(seen.join() === 'offline', `expected one offline notice, saw ${JSON.stringify(seen)}`);
    state = watch.state();
    assert(state === 'offline', `watch reported ${state}`);
    // Flapping must not shout: repeated offline outcomes inside the throttle window are suppressed
    // by the notifier rather than producing a second balloon.
    const fake = { show: (kind) => { seen.push(kind); return Promise.resolve({ shown: false, via: 'suppressed' }); } };
    watch.observe({ retryInMs: 400000 });
    assert(seen.length === 2, `offline was announced ${seen.length} times for one outage`);
    // Back up: the transition is what earns the notice, and it is the *previous* state that says so.
    const up = watch.observe({ unchanged: true });
    assert(up === 'online' && seen.at(-1) === 'online',
      `recovery reported ${up} and announced ${JSON.stringify(seen)}`);
    // A pin mismatch is the one error the person at the keyboard can usefully escalate.
    watch.observe({ terminal: { code: 'tls_pin_mismatch' } });
    assert(seen.at(-1) === 'unverified', `pin failure announced ${JSON.stringify(seen)}`);
    // A revoked or unapproved device is a consent fact, not a link fact: no balloon for it.
    const before = seen.length;
    watch.observe({ terminal: { code: 'state_not_approved' } });
    assert(seen.length === before, 'the agent popped a notice for an administrative state');
    watch.stop();
    assert(retries.length === 0, 'a retry fired after stop(); a stopped agent must go quiet');
    return `offline -> online -> unverified in order, flap-suppressed, retry capped and cancelled on stop`;
  });

  await check('the retry the connection watch schedules is fast enough to be called real time', async () => {
    const { createConnectionWatch } = await import('../agent/lib/connection.js');
    const fired = [];
    const watch = createConnectionWatch({
      notifier: { show: () => Promise.resolve({}) }, log: () => {},
      onRetry: () => { fired.push(Date.now()); }, retryCapMs: 1500,
    });
    const started = Date.now();
    watch.observe({ retryInMs: 900000 }); // the old ceiling: fifteen minutes
    await sleep(2000);
    assert(fired.length === 1, `retry timer fired ${fired.length} times in 2s`);
    const waited = fired[0] - started;
    assert(waited < 2000, `the capped retry waited ${waited}ms`);
    watch.stop();
    const { backoffDelay } = await import('../agent/lib/producers.js');
    assert(backoffDelay(9, 2000, 120000) <= 120000, 'the flush backoff escaped its 2 minute ceiling');
    return `a 900000ms backoff was retried after ${waited}ms; flush ceiling 120000ms`;
  });

  await check('notices fit the balloon, are throttled per kind, and are recorded for status', async () => {
    const { createNotifier, ALERTS } = await import('../agent/lib/notify.js');
    const dir = path.join(TMP, 'notify');
    rmSync(dir, { recursive: true, force: true });
    const texts = Object.entries(ALERTS).map(([k, v]) => [k, v.title, v.text]);
    // Windows clips a balloon it cannot fit, and a clipped disclosure sentence is worse than a short
    // one -- the bounds are asserted rather than discovered on a device.
    for (const [kind, title, text] of texts) {
      assert(title.length <= 63, `${kind} title is ${title.length} chars, over the 63 a balloon shows`);
      assert(text.length <= 240, `${kind} text is ${text.length} chars, over the 240 a balloon shows`);
      assert(!/password|token|secret/i.test(text), `${kind} wording mentions a credential`);
      assert(/CTTIme/i.test(title), `${kind} title does not name the program`);
    }
    const n = createNotifier({ workDir: dir, log: () => {}, minIntervalSeconds: 3600 });
    const first = await n.show('approved');
    assert(first.shown, `a real notice was not displayed on this host: ${first.error ?? first.reason}`);
    assert(first.via === 'balloon', `notice went out over ${first.via}`);
    const second = await n.show('approved');
    assert(second.shown === false && second.via === 'suppressed',
      'the same notice was repeated inside its own window');
    const record = JSON.parse(readFileSync(path.join(dir, 'notifications.json'), 'utf8'));
    assert(record.sent === 1 && record.history[0].kind === 'approved',
      `the record status reads says ${JSON.stringify(record)}`);
    // The summary notice has to survive substitution without exceeding the balloon.
    const filled = await n.show('collecting', {
      values: { screenshots: 12, events: 340, dropped: 0, since: '22h' },
    });
    assert(filled.shown, 'the daily summary notice was not displayed');
    return `${texts.length} kinds, longest text ${Math.max(...texts.map((t) => t[2].length))} chars; shown, throttled and recorded`;
  });

  await check('the certificate pin is compared on every new connection, not only the first', async () => {
    // Regression: Node caches TLS client sessions, and a resumed session is an abbreviated
    // handshake that does not re-send the certificate. getPeerCertificate() then comes back
    // without a DER, and the pinned transport threw tls_no_certificate on every connection after
    // the first idle gap -- an approved agent that could never report its own gate status.
    // Destroying the agent's sockets forces a fresh handshake while leaving the session cache
    // intact, which is what a 30s gap does in the field but without waiting for it.
    const { createTransport } = await import('../agent/lib/transport.js');
    // The agent-side section runs after the main collector has been stopped for the claim-flow
    // checks, so this one boots its own rather than depending on section order.
    await startCollector({ CTTIme_BOOTSTRAP_ACCOUNT: `${COLLECTOR_ACCOUNT}:${COLLECTOR_PASSWORD}` });
    try {
      const good = createTransport({ host: '127.0.0.1', port, pin });
      const first = await good.get('/api/v1/notice');
      assert(first.status === 200, `first connection over the real pin returned ${first.status}`);
      good.agent.destroy();
      const second = await good.get('/api/v1/notice');
      assert(second.status === 200, 'a reconnect was refused for want of a certificate');
      good.close();

      // The other half: a wrong pin has to keep failing on the reconnect too. If absence of a
      // certificate were ever treated as already-verified, this is where a MITM would slip through.
      const wrong = createTransport({ host: '127.0.0.1', port, pin: 'ab'.repeat(32) });
      const err1 = await wrong.get('/api/v1/notice').then(() => null, (e) => e);
      assert(err1?.code === 'tls_pin_mismatch', `wrong pin returned ${err1?.code ?? 'no error'}`);
      wrong.agent.destroy();
      const err2 = await wrong.get('/api/v1/notice').then(() => null, (e) => e);
      assert(err2?.code === 'tls_pin_mismatch',
        `wrong pin on a fresh connection returned ${err2?.code ?? 'no error'} — the pin was not compared`);
      wrong.close();
      return 'right pin passes twice, wrong pin refused twice, no session reused between them';
    } finally {
      await stopCollector();
    }
  });

  await check('every advertised client command returns instead of hanging', async () => {
    // `check` is documented as a pre-flight, and it used to fall straight into the resident loop:
    // it printed nothing and never exited, which reads as "the agent is not running".
    const { spawnSync } = await import('node:child_process');
    // Same reason as the pin check below: the agent-side section runs after the main collector
    // has been stopped for the claim-flow checks.
    await startCollector({ CTTIme_BOOTSTRAP_ACCOUNT: `${COLLECTOR_ACCOUNT}:${COLLECTOR_PASSWORD}` });
    try {
      const out = spawnSync(process.execPath, ['cli.js', 'check', '--host', '127.0.0.1',
        '--port', String(port), '--pin', pin, '--state-dir', path.join(TMP, 'cli-check')], {
        cwd: path.join(ROOT, 'agent'), encoding: 'utf8', timeout: 30000,
      });
      assert(out.status !== null, `check did not exit on its own (signal ${out.signal})`);
      assert(out.status === 0, `check exited ${out.status}: ${(out.stderr || out.stdout).slice(0, 200)}`);
      const report = JSON.parse(out.stdout);
      assert(report.status === 'check', `check reported ${report.status}`);
      assert(report.pin_verified === true, 'check reported an unverified pin after a good request');
      assert(report.notice_version, 'check returned no notice version');
      const bad = spawnSync(process.execPath, ['cli.js', 'check', '--host', '127.0.0.1',
        '--port', String(port), '--pin', 'f'.repeat(64),
        '--state-dir', path.join(TMP, 'cli-check-bad')], {
        cwd: path.join(ROOT, 'agent'), encoding: 'utf8', timeout: 30000,
      });
      assert(bad.status === 1, `a wrong pin exited ${bad.status}, expected 1`);
      const badReport = JSON.parse(bad.stdout);
      assert(badReport.status === 'check_failed' && badReport.error === 'tls_pin_mismatch',
        `wrong pin reported ${JSON.stringify(badReport).slice(0, 120)}`);
      assert(badReport.pin_verified === false, 'a refused certificate reported a verified pin');
      return `exited in time, enrollment read as ${report.enrollment}, wrong pin exits 1`;
    } finally {
      await stopCollector();
    }
  });

  console.log('\nResults');
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  writeFileSync(path.join(TMP, 'results.json'), JSON.stringify(results, null, 2));
  if (failed) process.exitCode = 1;
}

function dbColumnsOf(table) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(ROOT, 'server', 'lib', 'schema.sql'), 'utf8'));
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
  db.close();
  return cols;
}

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err);
  process.exitCode = 1;
});
