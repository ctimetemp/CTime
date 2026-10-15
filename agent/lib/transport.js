import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { HttpError } from './errors.js';

// One keep-alive agent for the whole process: a flush must not pay a TLS handshake, and with
// keepAlive the steady state is a single TCP connection per device.
//
// rejectUnauthorized is false because the certificate is self-signed and untrusted by the OS
// store. Trust is re-established below by comparing the SHA-256 of the presented DER against the
// pin supplied at install. That check is what makes this safe; without it, rejectUnauthorized:false
// would accept any machine on the path, so it is not optional and there is no fallback request
// path that skips it.
//
// `ports` (or a single `port`) is the collector's listener set. Every listener on the collector
// presents the same certificate and serves the same router, so the list is availability, not
// identity: the pin check is unchanged whichever port a request lands on.
export function createTransport({ host, port, ports, pin, timeoutMs = 15000 }) {
  if (!/^[0-9a-f]{64}$/i.test(String(pin ?? ''))) {
    throw new HttpError(0, 'pin_missing', 'a 64-hex-char certificate fingerprint is required');
  }
  const list = [...new Set((ports ?? [port]).map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535))];
  if (list.length === 0) throw new HttpError(0, 'port_missing', 'no usable collector port supplied');
  let cursor = 0;
  const expected = Buffer.from(String(pin).toLowerCase(), 'hex');
  const agent = new HttpsAgent({
    keepAlive: true,
    rejectUnauthorized: false,
    // Session caching must stay off. A resumed TLS session is an abbreviated handshake: the server
    // does not send its certificate again, so getPeerCertificate() comes back empty and the pin has
    // nothing to compare. Node caches client sessions by default, so every connection after the
    // first idle gap resumed and failed checkPinning with tls_no_certificate -- which left an
    // approved agent unable to report its gate status. The tempting fix is to treat "no certificate"
    // as already-verified; that would accept a session an attacker established, so instead caching
    // is disabled and every handshake carries a certificate to pin.
    maxCachedSessions: 0,
  });
  // A reused keep-alive socket does not re-emit secureConnect, so verified sockets are tracked
  // once each rather than checked on every request.
  const verified = new WeakSet();
  // Set only when a certificate has actually been compared against the pin, so `check` can report
  // the same fact the python client reports instead of implying trust from a successful request.
  let pinCompared = false;

  function checkPinning(socket, label) {
    if (!socket || verified.has(socket)) return;
    const cert = socket.getPeerCertificate?.(true);
    if (!cert || !cert.raw) {
      socket.destroy();
      throw new HttpError(0, 'tls_no_certificate', `${label}: peer presented no certificate`);
    }
    const got = createHash('sha256').update(cert.raw).digest();
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      socket.destroy();
      throw new HttpError(0, 'tls_pin_mismatch',
        `${label}: cert ${got.toString('hex')} does not match the pin. Refusing to send. `
        + 'This means the collector was reinstalled, or something else is answering on that port.');
    }
    verified.add(socket);
    pinCompared = true;
  }

  function requestOn(usePort, method, pathname, { headers = {}, body, stream, expectStatus = [200], maxResponseBytes = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolveP, rejectP) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; rejectP(err); } };
      const req = httpsRequest({
        host, port: usePort, method, path: pathname, agent,
        // Server name is deliberately not a hostname the pin has to match: identity is the
        // fingerprint, so a device with no DNS entry on the LAN still works.
        servername: undefined,
        headers: { host: `${host}:${usePort}`, ...headers },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxResponseBytes) {
            res.destroy();
            fail(new HttpError(res.statusCode ?? 0, 'response_too_large', 'response exceeded bounds'));
          } else chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(chunks);
          resolveP({ status: res.statusCode, headers: res.headers, body: buf });
        });
        res.on('error', (e) => fail(new HttpError(0, 'network', e.message)));
      });
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => { try { checkPinning(socket, pathname); } catch (e) { fail(e); } });
      });
      req.on('error', (e) => {
        // An error raised by the pin check surfaces here as well; keep the specific code.
        if (e instanceof HttpError) fail(e);
        else fail(new HttpError(0, 'network', e.code === 'ECONNREFUSED' ? 'collector unreachable' : e.message));
      });
      req.on('timeout', () => { req.destroy(new HttpError(0, 'timeout', 'request timed out')); });
      req.on('response', () => { try { checkPinning(req.socket, pathname); } catch (e) { req.destroy(); fail(e); } });

      if (stream) createReadStream(stream).pipe(req);
      else if (body !== undefined) req.end(body);
      else req.end();
    }).then((res) => {
      if (!expectStatus.includes(res.status)) {
        let parsed = {};
        try { parsed = JSON.parse(res.body.toString('utf8') || '{}'); } catch { /* non-JSON error body */ }
        throw new HttpError(res.status, parsed.error ?? 'unexpected_status',
          parsed.detail ?? `HTTP ${res.status}`, parsed.retry_after);
      }
      return res;
    });
  }

  // Ports are tried in the configured order, starting from the one that last worked. Only a
  // connection-level failure moves on: no response arrived, so the collector's router never saw
  // the request and trying the next port cannot duplicate a write. (Every POST here is idempotent
  // on its event id regardless.) A TLS verdict is terminal and never causes a port switch -- all
  // the listeners carry the same certificate, so a mismatch means something else is answering, not
  // that the next port would be better.
  function isConnectionLevel(err) {
    return err instanceof HttpError && (err.code === 'network' || err.code === 'timeout');
  }

  async function send(method, pathname, options) {
    let lastError = null;
    for (let step = 0; step < list.length; step++) {
      const index = (cursor + step) % list.length;
      try {
        const res = await requestOn(list[index], method, pathname, options);
        cursor = index;
        return res;
      } catch (err) {
        if (!isConnectionLevel(err)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new HttpError(0, 'network', 'collector unreachable on every configured port');
  }

  return {
    agent,
    pinVerified: () => pinCompared,
    ports: () => [...list],
    activePort: () => list[cursor],
    get: (p, headers) => send('GET', p, { headers, expectStatus: [200, 304] }),
    postJson: (p, obj, headers = {}) => send('POST', p, {
      headers: { 'content-type': 'application/json', ...headers },
      body: Buffer.from(JSON.stringify(obj)),
      expectStatus: [200, 201, 202, 204],
    }),
    postGzipNdjson: (p, lines, headers = {}) => new Promise((resolveP, rejectP) => {
      const payload = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
      const chunks = [];
      const gz = createGzip({ level: 6 });
      gz.on('data', (c) => chunks.push(c));
      gz.on('end', () => resolveP(Buffer.concat(chunks)));
      gz.on('error', rejectP);
      gz.end(payload);
    }).then((gzBuf) => send('POST', p, {
      headers: { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip',
        'content-length': gzBuf.length, ...headers },
      body: gzBuf,
      expectStatus: [200],
    })),
    postPng: (p, file, headers) => send('POST', p, {
      headers: { 'content-type': 'application/png', 'transfer-encoding': 'chunked', ...headers },
      stream: file,
      expectStatus: [200, 201],
    }),
    close: () => agent.destroy(),
  };
}
