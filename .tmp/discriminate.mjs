// Would the new acceptance check have caught the old configuration? Replays checkPinning's exact
// decision against an agent built the way transport.js used to build it.
import { request, Agent as HttpsAgent } from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const dataDir = '.tmp/discdata';
const port = 8488;
const child = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, CTTIme_DATA: dataDir, CTTIme_BIND: '127.0.0.1', CTTIme_PORT: String(port),
    CTTIme_BOOTSTRAP_ACCOUNT: 'lcadmin:disc-pass-1' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 5000));
const pin = readFileSync(`${dataDir}/tls/fingerprint.txt`, 'utf8').trim();
const expected = Buffer.from(pin, 'hex');

function probe(label, agent) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/notice', agent,
      rejectUnauthorized: false, servername: undefined }, (res) => {
      res.resume(); res.on('end', () => resolve());
    });
    req.on('socket', (s) => s.on('secureConnect', () => {
      const cert = s.getPeerCertificate(true);
      if (!cert || !cert.raw) { console.log(`${label}: tls_no_certificate`); req.destroy(); return resolve(); }
      const got = createHash('sha256').update(cert.raw).digest();
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        console.log(`${label}: tls_pin_mismatch`); req.destroy(); return resolve();
      }
      console.log(`${label}: pin verified`);
    }));
    req.on('error', () => resolve());
    req.end();
  });
}

for (const [name, opts] of [['OLD maxCachedSessions:4', { maxCachedSessions: 4 }],
                            ['NEW maxCachedSessions:0', { maxCachedSessions: 0 }]]) {
  const a = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false, ...opts });
  await probe(`${name} connect#1`, a);
  a.destroy();                      // sockets gone, TLS session cache left in place
  await probe(`${name} connect#2`, a);
}
child.kill();
process.exit(0);
