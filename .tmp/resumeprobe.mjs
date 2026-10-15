// Does a second handshake on the same agent reuse the TLS session, and does the peer
// certificate survive it? Forcing req.destroy() after the response makes the next request
// open a fresh socket on the same agent, which is exactly what a 30s idle gap does in the
// field -- but without waiting for it.
import { request, Agent as HttpsAgent } from 'node:https';

const port = Number(process.argv[2] ?? 8466);
const opts = JSON.parse(process.argv[3] ?? '{}');

function probe(label, agent) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/notice', agent,
      rejectUnauthorized: false, servername: undefined }, (res) => {
      const s = req.socket;
      const c = s.getPeerCertificate(true);
      res.resume();
      res.on('end', () => {
        console.log(`[${label}] reused=${s.isSessionReused()} raw=${c && c.raw ? c.raw.length : 'NONE'}`
          + ` sha=${c && c.raw ? c.raw.toString('hex').slice(0, 16) + '...' : 'n/a'} proto=${s.getProtocol()}`);
        // Drop the socket so the next probe must perform a new handshake on this agent.
        s.destroy();
        resolve();
      });
    });
    req.on('error', (e) => { console.log(`[${label}] error: ${e.message}`); resolve(); });
    req.end();
  });
}

function makeAgent() {
  return new HttpsAgent({ keepAlive: true, rejectUnauthorized: false, ...opts });
}

const a = makeAgent();
console.log(`agent options: ${JSON.stringify(opts)}`);
for (let i = 1; i <= 3; i += 1) await probe(`destroy-between#${i}`, a);
a.destroy();
process.exit(0);
