// Throughput bench for the collector's ingest paths. It boots a real collector on an ephemeral
// loopback port in .tmp/perf, drives it over the same TLS routes an agent uses, and reports latency
// percentiles plus what actually landed in the database.
//
// The point is to answer "can one box on a LAN take the traffic from N devices" with a measurement
// instead of a guess, and to catch a collector that is fast because it quietly dropped something:
// every phase ends by comparing the server's own accepted counts and the stored rows against what
// was sent, so a lossy handler fails the run rather than producing a flattering number.
//
// Run: node scripts/perf-bench.js [--devices=20] [--batches=10] [--events=50] [--shots=30]
//                                 [--shot-kb=256] [--concurrency=20]
//
// Nothing here touches server/data or a live collector, and the synthetic device identities are
// named as synthetic in the consent field so a bench row can never be mistaken for a real one.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request, Agent } from 'node:https';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.tmp', 'perf');
const ACCOUNT = 'benchadmin';
const PASSWORD = 'bench-only-pass-1';

function parse(argv) {
  const o = { devices: 20, batches: 10, events: 50, shots: 30, shotKb: 256, concurrency: 20 };
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.+)$/.exec(a);
    if (!m) throw new Error(`unknown argument ${a} (expected --devices=N and friends)`);
    const key = { 'shot-kb': 'shotKb' }[m[1]] ?? m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in o)) throw new Error(`unknown option --${m[1]}`);
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${m[1]} must be a positive integer`);
    o[key] = n;
  }
  return o;
}

const opts = parse(process.argv.slice(2));

let port = null;
let child = null;
const keepAlive = new Agent({ keepAlive: true });

function http(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = request({
      host: '127.0.0.1', port, path: urlPath, method, agent: keepAlive, rejectUnauthorized: false,
      headers: { ...(body ? { 'content-length': body.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { json = null; }
        resolve({
          status: res.statusCode, json, buf, headers: res.headers,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function percentile(samples, p) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function phase(name, total, fn, rate) {
  const latencies = [];
  const extras = [];
  let next = 0;
  const t0 = process.hrtime.bigint();
  const workers = Array.from({ length: Math.min(opts.concurrency, total) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const { ms, extra } = await fn(i);
      latencies.push(ms);
      if (extra) extras.push(extra);
    }
  });
  await Promise.all(workers);
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const units = extras.reduce((sum, e) => sum + (e ?? 0), 0);
  const line = `  ${name.padEnd(26)} ${String(total).padStart(6)} req  `
    + `p50 ${percentile(latencies, 50).toFixed(1).padStart(6)}ms  `
    + `p95 ${percentile(latencies, 95).toFixed(1).padStart(6)}ms  `
    + `p99 ${percentile(latencies, 99).toFixed(1).padStart(6)}ms  `
    + `${(total / seconds).toFixed(0).padStart(7)} req/s`;
  console.log(line + (units && rate ? `  ${rate(units, seconds)}` : ''));
  return { extras, seconds, units };
}

// A minimal valid PNG built with node:zlib so the bench commits no binary fixture. The collector
// reads dimensions from the IHDR, so these must be a real header, not filler bytes.
//
// The pixels come from a linear congruential generator, not a repeating pattern: a screenshot phase
// is only a screenshot phase if the body is roughly incompressible, otherwise --shot-kb silently
// measures a file a twentieth of the requested size.
function makePng(width, height, seed) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let state = (seed * 2654435761) >>> 0;
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[y * (stride + 1) + 1 + x] = state >>> 24;
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crcV = 0xffffffff;
    for (const byte of body) crcV = table[(crcV ^ byte) & 0xff] ^ (crcV >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crcV ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', gzipSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

// The streaming claim in the contract is that the collector pipes the socket to disk instead of
// buffering the image, so the memory figure has to come from the collector process itself.
// tasklist is on every supported Windows host and needs no dependency.
function rssKiB(pid) {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const quoted = (out.stdout ?? '').match(/"[^"]*",\s*"([^"]*)"\s*$/m);
  const n = Number((quoted?.[1] ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function startCollector() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'screenshots'), { recursive: true });
  const lines = [];
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CTTIme_PORT: '0',
      CTTIme_BIND: '127.0.0.1',
      CTTIme_DATA: TMP,
      CTTIme_DB: path.join(TMP, 'collector.db'),
      CTTIme_SHOTS: path.join(TMP, 'screenshots'),
      CTTIme_BOOTSTRAP_ACCOUNT: `${ACCOUNT}:${PASSWORD}`,
    },
  });
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(`[stderr] ${String(d)}`));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const m = /listening\s+https:\/\/[\d.]+:(\d+)/.exec(lines.join(''));
    if (m) { port = Number(m[1]); return; }
    if (/EADDRINUSE|Error:/.test(lines.join(''))) throw new Error(lines.join(''));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`collector did not bind:\n${lines.join('')}`);
}

function stopCollector() {
  if (child && !child.killed) child.kill();
  child = null;
}

async function main() {
  await startCollector();
  console.log(`\nCTTIme perf bench  collector on 127.0.0.1:${port}`);
  console.log(`  ${opts.devices} devices x ${opts.batches} batches x ${opts.events} events, `
    + `${opts.shots} screenshots of ~${opts.shotKb} KiB, concurrency ${opts.concurrency}\n`);

  const login = await http('POST', '/api/login', {
    body: Buffer.from(JSON.stringify({ account: ACCOUNT, password: PASSWORD })),
    headers: { 'content-type': 'application/json' },
  });
  if (login.status !== 200) throw new Error(`login returned ${login.status} ${JSON.stringify(login.json)}`);
  const adminHeaders = {
    cookie: login.headers['set-cookie']?.[0]?.split(';')[0] ?? '',
    'x-csrf-token': login.json.csrf,
    'content-type': 'application/json',
  };

  const notice = await http('GET', '/api/v1/notice');
  const devices = [];
  for (let i = 0; i < opts.devices; i++) {
    const fingerprint = createHash('sha256').update(`bench-device-${i}`).digest('hex');
    const e = await http('POST', '/api/v1/enroll', {
      body: Buffer.from(JSON.stringify({
        fingerprint,
        hostname: `BENCH-${String(i).padStart(3, '0')}`,
        os_build: '10.0.26200',
        device_user: 'bench.runner',
        agent_version: '0.0.0-bench',
        notice_version: notice.json.version,
        acknowledged_by: 'SYNTHETIC BENCH DEVICE - not a real person',
        acknowledged_at: new Date().toISOString(),
      })),
      headers: { 'content-type': 'application/json' },
    });
    if (e.status !== 202) throw new Error(`enroll ${i} returned ${e.status} ${JSON.stringify(e.json)}`);
    // Approving through the admin route keeps the bench on the same consent gate a real operator
    // crosses; a device that was never approved would be rejected on ingest and the numbers would
    // measure the rejection path instead of the write path.
    await http('POST', `/api/devices/${e.json.device_id}/approve`, {
      body: Buffer.from('{}'), headers: adminHeaders,
    });
    const s = await http('GET', `/api/v1/enroll/status?fingerprint=${fingerprint}`);
    if (!s.json?.token) throw new Error(`no token for device ${i}`);
    devices.push({ id: e.json.device_id, token: s.json.token });
  }

  const now = () => new Date().toISOString();
  const bearer = (t) => ({ authorization: `Bearer ${t}` });

  function batchLines(device, k) {
    const ts = now();
    return Array.from({ length: opts.events }, (_, i) => JSON.stringify(
      i % 4 === 0
        ? { event_id: randomUUID(), type: 'screen_state', device_id: device.id, ts, data: { sampled_at: ts, state: 'active' } }
        : i % 4 === 1
          ? { event_id: randomUUID(), type: 'clipboard_metric', device_id: device.id, ts, data: { sampled_at: ts, char_count: 32, sha256: sha256Of(randomUUID()), content_kind: 'text' } }
          : i % 4 === 2
            // The real shape for this type: it names the frame that was skipped, so a malformed
            // line here would show up in the accepted count and fail the loss check at the end.
            ? { event_id: randomUUID(), type: 'screenshot_skipped_unchanged', device_id: device.id, ts, data: { captured_at: ts, sha256: sha256Of('previous-frame'), phash: 'a09272b0b0b08081' } }
            : { event_id: randomUUID(), type: 'extension_inventory', device_id: device.id, ts, data: { collected_at: ts, browser: 'chrome', profile: 'Bench', extensions: [{ ext_id: sha256Of(randomUUID()).slice(0, 40), name: 'Bench Ext', version: '1', source: 'webstore', permissions: [], enabled: true }] } },
    )).join('\n');
  }

  const sha256Of = (s) => createHash('sha256').update(s).digest('hex');
  const gzipBody = (device) => gzipSync(Buffer.from(batchLines(device)));
  const ndjsonHeaders = (token) => ({
    ...bearer(token), 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson',
  });

  const heartbeatBody = () => Buffer.from(JSON.stringify({
    policy_etag: '"bench"', spool_bytes: 0, spool_dropped: 0, bytes_sent: 1024,
  }));

  let eventsAccepted = 0;
  await phase('heartbeat', opts.devices * opts.batches, async (i) => {
    const d = devices[i % devices.length];
    const r = await http('POST', '/api/v1/heartbeat', {
      body: heartbeatBody(), headers: { ...bearer(d.token), 'content-type': 'application/json' },
    });
    if (r.status !== 204 && r.status !== 200) throw new Error(`heartbeat ${r.status} ${JSON.stringify(r.json)}`);
    return { ms: r.ms, extra: null };
  });

  const dupeBatch = gzipBody(devices[0]);

  await phase('batch ingest', opts.devices * opts.batches, async (i) => {
    const d = devices[i % devices.length];
    const r = await http('POST', '/api/v1/batch', { body: gzipBody(d), headers: ndjsonHeaders(d.token) });
    if (r.status !== 200) throw new Error(`batch ${r.status} ${JSON.stringify(r.json)}`);
    eventsAccepted += r.json.accepted;
    return { ms: r.ms, extra: r.json.accepted };
  }, (units, seconds) => `${(units / seconds).toFixed(0)} events/s`);

  // The pixels are noise, so the IDAT is very close to width*3*height and the requested size turns
  // straight into a frame height instead of a search that silently settles for less.
  const png = makePng(640, Math.max(16, Math.round((opts.shotKb * 1024) / (640 * 3))), 7);
  if (Math.abs(png.length - opts.shotKb * 1024) > opts.shotKb * 1024 * 0.2) {
    throw new Error(`generated frame is ${png.length} bytes, not the requested ${opts.shotKb} KiB`);
  }
  const pngSha = createHash('sha256').update(png).digest('hex');
  let shotsStored = 0;
  const beforeShots = rssKiB(child.pid);
  await phase('screenshot stream', opts.shots, async (i) => {
    const d = devices[i % devices.length];
    const r = await http('POST', '/api/v1/screenshots', {
      body: png,
      headers: {
        ...bearer(d.token), 'content-type': 'application/png',
        'x-event-id': randomUUID(), 'x-device-id': d.id,
        'x-captured-at': now(), 'x-sha256': pngSha, 'x-phash': 'a09272b0b0b08081',
      },
    });
    if (r.status !== 201) throw new Error(`screenshot ${r.status} ${JSON.stringify(r.json)}`);
    shotsStored += 1;
    return { ms: r.ms, extra: png.length };
  }, (units, seconds) => `${(units / seconds / 1048576).toFixed(1)} MiB/s`);
  const afterShots = rssKiB(child.pid);

  // One batch kept aside so the run can prove that a re-delivery stores nothing twice, which is what
  // makes an agent's retry-after-lost-response safe at these rates.
  const firstSend = await http('POST', '/api/v1/batch', {
    body: dupeBatch, headers: ndjsonHeaders(devices[0].token),
  });
  const resend = await http('POST', '/api/v1/batch', {
    body: dupeBatch, headers: ndjsonHeaders(devices[0].token),
  });
  eventsAccepted += firstSend.json?.accepted ?? 0;

  const db = new DatabaseSync(path.join(TMP, 'collector.db'));
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const rows = {
    clipboard_metrics: count('clipboard_metrics'),
    screen_states: count('screen_states'),
    extension_inventory: count('extension_inventory'),
    screenshots: count('screenshots'),
  };
  db.close();

  const bytes = dirBytes(path.join(TMP, 'screenshots'));
  console.log(`
  stored                clipboard ${rows.clipboard_metrics}  screen_state ${rows.screen_states}  `
    + `extensions ${rows.extension_inventory}  screenshots ${rows.screenshots}`);
  console.log(`  accepted reported     ${eventsAccepted} events across ${opts.devices * opts.batches + 1} batches`);
  console.log(`  duplicate resupply    ${JSON.stringify(resend.json)}`);
  console.log(`  on disk               db ${(statSync(path.join(TMP, 'collector.db')).size / 1048576).toFixed(1)} MiB, `
    + `screenshots ${(bytes / 1048576).toFixed(1)} MiB in ${opts.shots} files`);
  console.log(`  collector memory      ${beforeShots} KiB before the image phase, ${afterShots} KiB after `
    + `(${(png.length * opts.shots / 1048576).toFixed(1)} MiB streamed)\n`);

  const sent = opts.devices * opts.batches * opts.events + opts.events;
  const mismatches = [];
  if (rows.screenshots !== shotsStored) mismatches.push(`screenshots stored ${rows.screenshots}, sent ${shotsStored}`);
  if (rows.clipboard_metrics + rows.screen_states + rows.extension_inventory === 0) {
    mismatches.push('no event rows landed at all');
  }
  if (eventsAccepted !== sent) {
    mismatches.push(`server accepted ${eventsAccepted} of ${sent} sent`);
  }
  if (resend.json?.duplicates !== opts.events || resend.json?.accepted !== 0) {
    mismatches.push(`re-sending a stored batch gave ${JSON.stringify(resend.json)}`);
  }
  if (mismatches.length) {
    for (const m of mismatches) console.log(`  LOSSY  ${m}`);
    return 1;
  }
  console.log('  all sent events accounted for, re-delivery suppressed, nothing dropped.');
  return 0;
}

main()
  .then((code) => { stopCollector(); process.exitCode = code; })
  .catch((err) => { stopCollector(); console.error(`perf-bench: ${err.message}`); process.exitCode = 1; });
