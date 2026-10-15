import { createTransport } from '../agent/lib/transport.js';
import { readFileSync } from 'node:fs';
const pin = readFileSync('.tmp/gatedata/tls/fingerprint.txt', 'utf8').trim();
const t = createTransport({ host: '127.0.0.1', port: 8477, pin, timeoutMs: 8000 });
let mismatch = 0;
for (let i = 1; i <= 15; i += 1) {
  try {
    const s = t.agent; // the transport exposes its agent
    const r = await t.get('/api/v1/notice');
    console.log(`#${i} ok status=${r.status}`);
  } catch (e) {
    mismatch += 1;
    console.log(`#${i} ${e.code}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 1500));
}
console.log(`mismatches: ${mismatch}/15`);
t.close();
process.exit(0);
