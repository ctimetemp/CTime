// Diagnostic: what does Node's pin check actually see on successive connections?
// Python's client verifies the pin on every fresh handshake and passes against the same
// collector; Node's agent reports tls_no_certificate and tls_pin_mismatch. This separates
// "session resumption delivered no certificate" from "a genuinely different certificate".
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import fs from 'node:fs';

const port = Number(process.argv[2] ?? 8466);
const dataDir = process.argv[3];
const pin = fs.readFileSync(`${dataDir}/tls/fingerprint.txt`, 'utf8').trim();
console.log('fingerprint.txt:', pin);

function probe(label, agent) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/notice', agent,
      rejectUnauthorized: false, servername: undefined }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('socket', (s) => {
      s.on('secureConnect', () => {
        const c = s.getPeerCertificate(true);
        const resumed = s.isSessionReused?.() ?? '?';
        console.log(`[${label}] secureConnect: raw=${c && c.raw ? c.raw.length + ' bytes' : 'NONE'}`
          + ` sha256=${c && c.raw ? createHash('sha256').update(c.raw).digest('hex') : 'n/a'}`
          + ` reused=${resumed} proto=${s.getProtocol()}`);
      });
    });
    req.on('response', () => {
      const s = req.socket;
      const c = s.getPeerCertificate(true);
      console.log(`[${label}] response:    raw=${c && c.raw ? c.raw.length + ' bytes' : 'NONE'}`
        + ` sha256=${c && c.raw ? createHash('sha256').update(c.raw).digest('hex') : 'n/a'}`
        + ` reused=${s.isSessionReused?.() ?? '?'}`);
    });
    req.on('error', (e) => { console.log(`[${label}] error: ${e.message}`); resolve(); });
    req.end();
  });
}

// A keep-alive agent, exactly as the real transport builds it.
const agent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false, maxCachedSessions: 4 });
for (let i = 1; i <= 4; i += 1) await probe(`shared#${i}`, agent);
// A fresh agent per request: no session cache at all.
for (let i = 1; i <= 2; i += 1) await probe(`fresh#${i}`, new HttpsAgent({ rejectUnauthorized: false }));
agent.destroy();
process.exit(0);
