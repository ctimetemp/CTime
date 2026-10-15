import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { HttpError } from './httpkit.js';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function scrypt(password, salt) {
  return new Promise((resolveP, rejectP) => {
    scryptCb(password, salt, SCRYPT.keylen, SCRYPT, (err, out) => {
      if (err) rejectP(err); else resolveP(out);
    });
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [tag, n, r, p, saltHex, hashHex] = String(stored).split('$');
    if (tag !== 'scrypt') return false;
    const derived = await scrypt(password, Buffer.from(saltHex, 'hex'));
    return timingSafeEqual(derived, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Accounts come from server/accounts.json (created by scripts/install.ps1) or the bootstrap env
// var. There is no compiled-in default password: a shipped credential is a credential nobody
// rotates.
export function loadAccounts(rawJson, env) {
  const accounts = new Map();
  try {
    for (const entry of JSON.parse(rawJson)) {
      if (entry?.account && entry?.password_hash) accounts.set(String(entry.account), entry.password_hash);
    }
  } catch { /* missing or malformed file is treated as "no accounts" */ }
  const boot = env.CTTIme_BOOTSTRAP_ACCOUNT;
  if (boot) {
    const i = boot.indexOf(':');
    if (i > 0) accounts.set(boot.slice(0, i), { plain: boot.slice(i + 1) });
  }
  return accounts;
}

export function createAuditor(db) {
  const stmt = db.prepare(
    'INSERT INTO audit_log (ts, actor, action, target, detail, ip) VALUES (datetime(\'now\'), ?, ?, ?, ?, ?)',
  );
  // detail must never contain secret values or payload contents. Callers pass key names and IDs.
  return ({ actor, action, target = null, detail = null, ip = null }) => {
    try { stmt.run(actor, action, target, detail, ip); } catch { /* audit must not break a request */ }
  };
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

export function createLoginGuard() {
  const failures = new Map();
  return {
    // Keyed by account AND ip: a single account hammering from many hosts and one host trying
    // many accounts both consume the same budget shape but are different attacks.
    check(account, ip) {
      const key = `${account}|${ip}`;
      const list = (failures.get(key) ?? []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
      if (list.length >= LOGIN_MAX_FAILURES) {
        const wait = Math.ceil((LOGIN_WINDOW_MS - (Date.now() - list[0])) / 1000);
        throw new HttpError(429, 'collector_busy', 'too many failed logins', Math.max(1, wait));
      }
    },
    noteFailure(account, ip) {
      const key = `${account}|${ip}`;
      const list = failures.get(key) ?? [];
      list.push(Date.now());
      failures.set(key, list);
    },
    clear(account, ip) { failures.delete(`${account}|${ip}`); },
  };
}

export function createSessionStore(db) {
  return {
    async start(account, ip) {
      const token = randomUUID();
      const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      db.prepare(
        'INSERT INTO admin_sessions (token_hash, account, created_at, expires_at, ip) VALUES (?, ?, datetime(\'now\'), ?, ?)',
      ).run(hashToken(token), account, expires, ip);
      return { token, expiresAt: expires };
    },
    resolve(token) {
      if (!token) return null;
      const row = db.prepare('SELECT account, expires_at FROM admin_sessions WHERE token_hash = ?')
        .get(hashToken(token));
      if (!row) return null;
      if (Date.parse(row.expires_at) < Date.now()) {
        db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
        return null;
      }
      return row.account;
    },
    end(token) {
      if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    },
    sweep() {
      db.prepare('DELETE FROM admin_sessions WHERE expires_at < datetime(\'now\')').run();
    },
  };
}

export const COOKIE_NAME = 'CTTIme_session';

export function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}

// CSRF token is bound to the session and required on every mutation. SameSite=Strict already
// blocks the classic cross-site POST, but the LAN dashboard is served over a self-signed cert on
// a hostname users may reach by IP -- the explicit token is the part that survives that.
//
// Derived from the session token, not the account name: an account name is printed on the
// dashboard and is often guessable ("itadmin"), so hashing it would hand any cross-origin script
// that could read one character of the page the value it needs to mutate state.
export function csrfFor(sessionToken) {
  if (!sessionToken) return '';
  return createHash('sha256').update(`csrf|${sessionToken}`).digest('hex').slice(0, 32);
}

export function requireCsrf(req, sessionToken) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const expected = csrfFor(sessionToken);
  const supplied = String(req.headers['x-csrf-token'] ?? '');
  if (!expected || supplied.length !== expected.length
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new HttpError(403, 'csrf_failed', 'missing or wrong X-CSRF-Token');
  }
}

export function requireBearer(req) {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new HttpError(401, 'token_invalid', 'Authorization: Bearer <token> required');
  return m[1].trim();
}
