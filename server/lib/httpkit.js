import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { readFile, stat } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, code, detail, retryAfter) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

// The dashboard renders hostnames, account names, extension names and audit details that all
// came out of the database, so every one of them is escaped at the point of interpolation. CSP
// is the second line of defence: nothing may load from anywhere but this collector.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
};

export function sendHtml(res, status, html, headers = {}) {
  const buf = Buffer.from(html);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(buf);
}

export function errorFrom(err) {
  if (err instanceof HttpError) {
    const body = { error: err.code, detail: err.detail ?? err.code };
    if (err.retryAfter) body.retry_after = err.retryAfter;
    return { status: err.status, body };
  }
  return { status: 500, body: { error: 'internal', detail: 'collector fault' } };
}

export function sendError(res, err) {
  const { status, body } = errorFrom(err);
  // A body we refused to finish reading leaves unread bytes on the socket, so the connection is
  // not reusable. Closing after the 413 is what lets the client actually read the status instead
  // of an ECONNRESET.
  const headers = status === 413 ? { connection: 'close' } : {};
  sendJson(res, status, body, headers);
}

// Every ingest route bounds the body before parsing. The cap is checked while bytes arrive, not
// after, so a misconfigured agent cannot make the collector allocate an oversized buffer.
export function readBody(req, maxBytes) {
  return new Promise((resolveP, rejectP) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        // Stop accumulating, but do not destroy: the caller still has to answer with 413. The
        // leftover bytes are discarded when the connection closes after the response.
        req.pause();
        rejectP(new HttpError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolveP(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!done) rejectP(new HttpError(400, 'bad_request', String(e.message || e))); });
  });
}

export async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new HttpError(400, 'bad_request', `invalid JSON: ${err.message}`);
  }
}

export function readGzip(req, maxBytes) {
  return new Promise((resolveP, rejectP) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      // Same rule as readBody: bound the inflate, stop reading, but keep the socket long enough
      // for the caller to send its 4xx. A gzip bomb must not be able to make the collector
      // allocate past the cap even if the compressed body is small.
      try { req.pause(); } catch { /* socket already gone */ }
      rejectP(err);
    };
    const gunzip = createGunzip();
    gunzip.on('error', (e) => fail(new HttpError(400, 'bad_request', `gzip: ${e.message}`)));
    gunzip.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        gunzip.destroy();
        fail(new HttpError(413, 'body_too_large', `decompressed body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    gunzip.on('end', () => { if (!done) resolveP(Buffer.concat(chunks)); });
    req.pipe(gunzip);
  });
}

export function etagOfBuffer(buf) {
  return `"${createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`;
}

// ETag/If-None-Match for JSON regions and the dashboard poll. A 304 must carry a zero-length
// body -- scripts/perf-bench.js asserts the byte count, so this is not cosmetic.
export function conditional(res, req, etag, cacheControl = 'no-cache') {
  res.setHeader('etag', etag);
  res.setHeader('cache-control', cacheControl);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return true;
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function sendStatic(res, req, rootDir, relPath) {
  const target = resolve(join(rootDir, normalize(relPath).replace(/^([/\\])+/, '')));
  // Containment check on the resolved path, not the request string: '../' sequences that
  // survive naive filtering are caught here by comparing against the root.
  if (target !== resolve(rootDir) && !target.startsWith(resolve(rootDir) + sep)) {
    throw new HttpError(400, 'bad_request', 'path traversal');
  }
  return new Promise((resolveP) => {
    stat(target, (err, st) => {
      if (err || !st.isFile()) { resolveP(false); return; }
      readFile(target, (readErr, buf) => {
        if (readErr) { resolveP(false); return; }
        const etag = etagOfBuffer(buf);
        if (conditional(res, req, etag, 'no-cache')) { resolveP(true); return; }
        res.writeHead(200, {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': buf.length,
        });
        res.end(buf);
        resolveP(true);
      });
    });
  });
}

// Exact-match router with :param support. Registration order is precedence.
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(seg.slice(1));
        return '([^/]+)';
      })
      .join('/');
    routes.push({ method, re: new RegExp(`^${source}$`), names, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    has(method, pathname) {
      return routes.some((r) => r.method === method && r.re.test(pathname));
    },
    match(method, pathname) {
      let pathExists = false;
      for (const r of routes) {
        const m = pathname.match(r.re);
        if (!m) continue;
        pathExists = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      throw new HttpError(pathExists ? 405 : 404, pathExists ? 'bad_request' : 'unknown_route',
        pathExists ? `${method} not allowed` : `no route for ${pathname}`);
    },
  };
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;

// Shared cursor parameters for every paged surface (JSON API and server-rendered pages), so a
// page link and an API call cannot drift apart on what "limit" and "cursor" mean.
export function pageParams(url) {
  const limitRaw = Number(url.searchParams.get('limit') ?? PAGE_DEFAULT);
  const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX);
  const cursorRaw = url.searchParams.get('cursor');
  const cursor = cursorRaw === null || cursorRaw === '' ? null : Number(cursorRaw);
  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 0)) {
    throw new HttpError(400, 'bad_request', 'cursor must be an integer');
  }
  return { limit, cursor };
}
