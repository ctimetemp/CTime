import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadOrGenerateCert, DATA } from './lib/boot.js';
import { openDatabase, isEmpty, loadSchema, stats, migrate } from './lib/db.js';
import { createRouter, sendJson, sendError, sendStatic, HttpError, clientIp } from './lib/httpkit.js';
import { createDeviceApi } from './lib/routes/device.js';
import { createAdminApi } from './lib/routes/admin.js';
import { createPages } from './lib/routes/pages.js';
import { createFileStore } from './lib/store.js';
import { startSweeper } from './lib/retention.js';
import { createNotice } from './lib/notice.js';
import {
  createSessionStore, createLoginGuard, loadAccounts, hashPassword, parseCookies,
  sessionCookie, clearCookie, COOKIE_NAME,
} from './lib/auth.js';
import { policyDocument } from './lib/policy.js';
import { createSetupCode, formatCode } from './lib/setup-code.js';

const SERVER_DIR = import.meta.dirname;
const PUBLIC_DIR = path.join(SERVER_DIR, 'public');

function parsePortList(raw) {
  const list = String(raw ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => Number(s));
  return [...new Set(list.filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535))];
}

function loadServerConfig() {
  const configFile = path.join(SERVER_DIR, 'collector.json');
  let file = {};
  if (existsSync(configFile)) {
    try { file = JSON.parse(readFileSync(configFile, 'utf8')); } catch (err) {
      console.error('[collector] collector.json is not valid JSON:', err.message);
    }
  }
  const primary = Number(process.env.CTTIme_PORT ?? file.port ?? 8443);
  // Additional listeners, each carrying exactly the same TLS certificate, router and session
  // store. They exist so an operator can put the collector behind a port set that is not the
  // obvious one, and so one blocked port does not blind every device. They are NOT a security
  // control: identity is still the pinned certificate fingerprint, and every listener answers the
  // same requests on the same bind address.
  const extraPorts = parsePortList(process.env.CTTIme_EXTRA_PORTS ?? file.extra_ports)
    .filter((p) => p !== primary);
  return {
    // Loopback by default. A collector for a LAN has to be opened to the LAN on purpose: the
    // alternative default bound every interface, and on a machine whose only network card carries
    // a public address that puts the ingest endpoint on the internet the first time somebody
    // forgets the environment variable.
    bind: process.env.CTTIme_BIND ?? file.bind ?? '127.0.0.1',
    port: primary,
    ports: [primary, ...extraPorts],
    tls: loadOrGenerateCert(path.join(DATA, 'tls')),
    dataDir: DATA,
    dbPath: process.env.CTTIme_DB ?? path.join(DATA, 'collector.db'),
    screenshotDir: process.env.CTTIme_SHOTS ?? path.join(DATA, 'screenshots'),
  };
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push({ name, address: entry.address });
    }
  }
  return out;
}

const serverConfig = loadServerConfig();
const db = openDatabase(serverConfig.dbPath);
if (isEmpty(db)) loadSchema(db, readFileSync(path.join(SERVER_DIR, 'lib/schema.sql'), 'utf8'));
// Existing databases predate the round-trip stamps. ALTER TABLE ADD COLUMN is additive, so a
// collector that is already holding consent records is upgraded in place rather than reset.
const addedColumns = migrate(db);

function makeAuditor() {
  const stmt = db.prepare(
    'INSERT INTO audit_log (ts, actor, action, target, detail, ip) VALUES (datetime(\'now\'), ?, ?, ?, ?, ?)',
  );
  // detail must never carry payload contents or secrets; callers pass ids, key names and counts.
  return ({ actor, action, target = null, detail = null, ip = null }) => {
    try { stmt.run(actor, action, target, String(detail ?? ''), ip); } catch { /* audit never breaks a request */ }
  };
}

const audit = makeAuditor();
const store = createFileStore(serverConfig.screenshotDir);
const notice = createNotice(db);
const sessions = createSessionStore(db);
const loginGuard = createLoginGuard();

const router = createRouter();

// Device API (agent-facing)
router.get('/api/v1/notice', (req, res, p, ip) => deviceApi.getNotice(req, res, p, ip));
router.post('/api/v1/enroll', (req, res, p, ip) => deviceApi.enroll(req, res, p, ip));
router.get('/api/v1/enroll/status', (req, res, p, ip) => deviceApi.enrollStatus(req, res, p, ip));
router.get('/api/v1/config', (req, res, p, ip) => deviceApi.getConfig(req, res, p, ip));
router.post('/api/v1/heartbeat', (req, res, p, ip) => deviceApi.heartbeat(req, res, p, ip));
router.post('/api/v1/batch', (req, res, p, ip) => deviceApi.batch(req, res, p, ip));
router.post('/api/v1/screenshots', (req, res, p, ip) => deviceApi.screenshot(req, res, p, ip));
router.post('/api/v1/clipboard-metric', (req, res, p, ip) => deviceApi.clipboardMetric(req, res, p, ip));

// Admin API. The session check is applied by prefix in the listener rather than per route, so a
// newly added /api route cannot be registered without it by accident.
router.get('/api/account-status', (req, res, p, ip) => adminApi.accountStatus(req, res, p, ip));
router.post('/api/claim', (req, res, p, ip) => adminApi.claim(req, res, p, ip));
router.post('/api/login', (req, res, p, ip) => adminApi.login(req, res, p, ip));
router.post('/api/logout', (req, res, p, ip) => adminApi.logout(req, res, p, ip));
router.get('/api/devices', (req, res, p, ip) => adminApi.devices(req, res, p, ip));
router.get('/api/devices/:id', (req, res, p, ip) => adminApi.deviceDetail(req, res, p, ip));
router.get('/api/devices/:id/verify', (req, res, p, ip) => adminApi.verifyDevice(req, res, p, ip));
router.post('/api/devices/:id/approve', (req, res, p, ip) => adminApi.approve(req, res, p, ip));
router.post('/api/devices/:id/reject', (req, res, p, ip) => adminApi.reject(req, res, p, ip));
router.post('/api/devices/:id/revoke', (req, res, p, ip) => adminApi.revoke(req, res, p, ip));
router.post('/api/devices/:id/reenable', (req, res, p, ip) => adminApi.reenable(req, res, p, ip));
router.get('/api/screenshots', (req, res, p, ip) => adminApi.screenshots(req, res, p, ip));
router.get('/media/screenshots/:id', (req, res, p, ip) => adminApi.mediaScreenshot(req, res, p, ip));
router.get('/api/extensions', (req, res, p, ip) => adminApi.extensions(req, res, p, ip));
router.get('/api/clipboard', (req, res, p, ip) => adminApi.clipboard(req, res, p, ip));
router.get('/api/audit', (req, res, p, ip) => adminApi.auditList(req, res, p, ip));
router.get('/api/policy', (req, res, p, ip) => adminApi.policyGet(req, res, p, ip));
router.put('/api/policy', (req, res, p, ip) => adminApi.policyPut(req, res, p, ip));
router.post('/api/policy/notice', (req, res, p, ip) => adminApi.noticePost(req, res, p, ip));
router.get('/api/telemetry-health', (req, res, p, ip) => adminApi.telemetryHealth(req, res, p, ip));
router.post('/api/export/:device', (req, res, p, ip) => adminApi.exportDevice(req, res, p, ip));

// Two authenticated surfaces share the /api prefix and must never be confused:
//   /api/v1/*  -- device-facing, authenticated by the per-device bearer token. An agent has no
//                session cookie, so applying the admin session check here rejects every agent.
//   /api/*     -- admin-facing, session cookie + CSRF.
// /api/login is the one admin path that must be reachable without a session.
// /api/account-status and /api/claim are the first-run pair: nobody can sign in until an account
// exists, so the sign-in page has to ask whether to show a login form or a claim form, and the
// claim itself is the thing that creates the account. Both are refused once one exists.
const SESSION_EXEMPT = new Set(['/api/login', '/api/account-status', '/api/claim']);
const isDevicePath = (p) => p.startsWith('/api/v1/');
const isApiPath = (p) => p.startsWith('/api/') || p.startsWith('/media/');
const needsSession = (p) => isApiPath(p) && !isDevicePath(p) && !SESSION_EXEMPT.has(p);
const setupCode = createSetupCode(serverConfig.dataDir);
const adminApi = createAdminApi({
  db, store, audit, notice, sessions, loginGuard, setupCode,
  accountOf: (req) => req.account ?? 'anonymous',
  tokenOf: (req) => req.sessionToken,
  sessionCookie,
  clearCookie,
});

const deviceApi = createDeviceApi({ db, store, audit, notice });

// Dashboard pages. A separate router from the JSON API because these answer with HTML and fail
// differently: an unauthenticated page is a redirect to the sign-in form, not a 401 body.
const pageRouter = createRouter();
const pages = createPages({ db, notice, audit });
pageRouter.get('/', (req, res) => pages.overview(req, res));
pageRouter.get('/login', (req, res) => pages.loginPage(req, res));
pageRouter.get('/screenshots', (req, res, p, ip) => pages.shots(req, res, p, ip));
pageRouter.get('/extensions', (req, res, p, ip) => pages.extensions(req, res, p, ip));
pageRouter.get('/clipboard', (req, res, p, ip) => pages.clipboard(req, res, p, ip));
pageRouter.get('/audit', (req, res, p, ip) => pages.audit(req, res, p, ip));
pageRouter.get('/health', (req, res, p, ip) => pages.health(req, res, p, ip));
pageRouter.get('/policy', (req, res, p, ip) => pages.policy(req, res, p, ip));
pageRouter.get('/devices/:id', (req, res, p, ip) => pages.device(req, res, p, ip));
pageRouter.get('/help', (req, res) => pages.helpPage(req, res));
for (const frag of ['pending', 'devices', 'health', 'shots', 'extensions', 'clipboard', 'audit']) {
  const handler = pages[`frag${frag[0].toUpperCase()}${frag.slice(1)}`];
  pageRouter.get(`/fragments/${frag}`, (req, res, p, ip) => handler(req, res, p, ip));
}
const PUBLIC_FILES = new Set(['/app.css', '/app.js', '/favicon.ico']);

const TLS_OPTIONS = {
  key: serverConfig.tls.key,
  cert: serverConfig.tls.cert,
  minVersion: 'TLSv1.2',
};

async function handle(req, res) {
  const started = process.hrtime.bigint();
  const pathname = new URL(req.url, 'http://x').pathname;
  const ip = clientIp(req);
  try {
    if (needsSession(pathname)) {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const account = sessions.resolve(token);
      if (!account) throw new HttpError(401, 'login_required', 'session required');
      req.account = account;
      req.sessionToken = token;
    }
    if (isApiPath(pathname)) {
      const matched = router.match(req.method, pathname);
      req.params = matched.params;
      await matched.handler(req, res, matched.params, ip);
    } else if (pageRouter.has(req.method, pathname)) {
      // Pages and fragments are session-scoped too. A fragment cannot redirect (the caller is
      // fetch, not the browser's navigation) so it answers 401 and the client re-navigates.
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const account = sessions.resolve(token);
      if (!account && pathname !== '/login') {
        if (pathname.startsWith('/fragments/')) throw new HttpError(401, 'login_required', 'session required');
        res.writeHead(303, { location: '/login' });
        res.end();
        return;
      }
      req.account = account ?? null;
      req.sessionToken = account ? token : null;
      const matched = pageRouter.match(req.method, pathname);
      req.params = matched.params;
      await matched.handler(req, res, matched.params, ip);
    } else {
      // Static dashboard assets. Reached only by names on this list, so the screenshot directory
      // is not a static root and an expired or absent file cannot be guessed at through the
      // filesystem.
      if (!PUBLIC_FILES.has(pathname)) throw new HttpError(404, 'unknown_route', `no route for ${pathname}`);
      const served = await sendStatic(res, req, PUBLIC_DIR, pathname);
      if (!served) throw new HttpError(404, 'unknown_route', `no route for ${pathname}`);
    }
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    if (!(err instanceof HttpError && err.status < 500)) console.error(`[collector] ${pathname}:`, err);
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 250) console.warn(`[collector] slow ${req.method} ${pathname} ${ms.toFixed(0)}ms`);
  }
}

const server = createServer(TLS_OPTIONS, handle);
// One server object per extra listener: node:https gives each its own socket set but they all run
// handle(), so a device on any of them sees the same routes, the same pin and the same database.
const extraServers = serverConfig.ports.slice(1)
  .map(() => createServer(TLS_OPTIONS, handle));

startSweeper(db, store, {
  onSweep: (r) => { if (r.rowsRemoved) console.log(`[retention] removed ${r.rowsRemoved} expired screenshots`); },
  onError: (err) => console.error('[retention] sweep failed:', err),
});
setInterval(() => sessions.sweep(), 60 * 60 * 1000).unref?.();

async function seedAccounts() {
  const accountsPath = path.join(SERVER_DIR, 'accounts.json');
  const raw = existsSync(accountsPath) ? readFileSync(accountsPath, 'utf8') : '[]';
  for (const [account, val] of loadAccounts(raw, process.env)) {
    if (db.prepare('SELECT 1 FROM admin_accounts WHERE account = ?').get(account)) continue;
    const hash = typeof val === 'string' ? val : await hashPassword(val.plain);
    db.prepare('INSERT INTO admin_accounts (account, password_hash, created_at) VALUES (?, ?, datetime(\'now\'))')
      .run(account, hash);
    console.log(`[collector] seeded admin account: ${account}`);
  }
}

function printBoot(srv) {
  // Report the socket the OS actually bound. With port 0 (tests, or "give me a free port") the
  // configured number is not the address anyone will connect to, and an operator reading stdout
  // needs the value that works.
  const addr = srv?.address?.() ?? {};
  const port = addr.port ?? serverConfig.port;
  // An extra listener that failed to bind is nulled out, not left half-open.
  const boundPorts = [port, ...extraServers.filter(Boolean).map((s) => s.address()?.port).filter(Boolean)];
  const bindHost = addr.address && addr.address !== '::' && addr.address !== '0.0.0.0'
    ? addr.address
    : serverConfig.bind;
  console.log('');
  console.log('  CTTIme collector');
  console.log(`  listening      https://${bindHost}:${port}`);
  for (const p of boundPorts.slice(1)) console.log(`  also listening https://${bindHost}:${p}`);
  // Print only the addresses the socket will accept on. Listing every interface while bound to
  // loopback sends the operator to an address that refuses connections, and the agent then fails
  // in a way that looks like a pin problem instead of an unroutable host.
  const bound = addr.address ?? serverConfig.bind;
  if (bound === '0.0.0.0' || bound === '::') {
    for (const entry of lanAddresses()) console.log(`  LAN address    https://${entry.address}:${port}  (${entry.name})`);
  } else {
    const via = boundPorts.map((p) => `https://${bound}:${p}`).join('  or  ');
    console.log(`  connect via    ${via}   (bound to one interface only)`);
    if (bound === '127.0.0.1' || bound === '::1' || bound === 'localhost') {
      console.log('                 loopback: only this machine can reach it. To serve the LAN,');
      console.log(`                 start with CTTIme_BIND=<this machine's LAN address>.`);
    }
  }
  console.log(`  database       ${serverConfig.dbPath}`);
  console.log(`  screenshots    ${serverConfig.screenshotDir}`);
  console.log(`  cert SHA-256   ${serverConfig.tls.fingerprint}`);
  console.log('');
  console.log('  Pin that fingerprint in the agent (--pin <hex>). There is no plaintext fallback');
  console.log('  and no negotiated downgrade if it does not match.');
  if (db.prepare('SELECT count(*) AS c FROM admin_accounts').get().c === 0) {
    // A fresh collector has no credential anywhere in its tree, which is the point -- but it also
    // means nobody can reach the dashboard until one is created. The code below proves the person
    // creating it is standing at this machine.
    const code = formatCode(setupCode.current());
    console.log('');
    console.log('  No administrator account yet. Nothing is collected until one exists, because');
    console.log('  an agent cannot be approved by nobody.');
    console.log('');
    console.log(`  Claim the first account at   https://${bindHost}:${port}/login`);
    console.log(`  first-run code              ${code}`);
    console.log(`  (also in ${path.join(serverConfig.dataDir, 'first-run-code.txt')})`);
    console.log('');
    console.log('  The code is random to this installation, is deleted the moment an account is');
    console.log('  created, and cannot sign anything in by itself. Prefer the console instead:');
    console.log('  node scripts/make-account.js <name>');
  } else {
    // Left over from a boot before the first account existed. It has no use now.
    setupCode.clear();
  }
  if (addedColumns.length) {
    console.log(`  database upgraded in place: added ${addedColumns.join(', ')} to devices`);
  }
  console.log('');
}

export { server, extraServers, db, store, router, serverConfig, stats, policyDocument, lanAddresses, seedAccounts, printBoot };

const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
  : false;

if (invokedDirectly) {
  await seedAccounts();
  // Extras bind first so printBoot can report the ports the OS actually gave them. A colliding
  // extra is announced and skipped rather than fatal: losing the second listener is not a reason
  // to stop collecting from every device on the primary.
  await Promise.all(serverConfig.ports.slice(1).map((p, i) => new Promise((resolveP) => {
    const srv = extraServers[i];
    srv.once('error', (err) => {
      console.error(`[collector] extra listener :${p} failed (${err.code ?? err.message}); `
        + `continuing without it`);
      extraServers[i] = null;
      resolveP();
    });
    srv.listen(p, serverConfig.bind, () => resolveP());
  })));
  server.listen(serverConfig.port, serverConfig.bind, () => printBoot(server));
}
