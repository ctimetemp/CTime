import { request, Agent as HttpsAgent } from 'node:https';
const port = 8466;
function probe(label, agent) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/notice', agent,
      rejectUnauthorized: false, servername: undefined }, (res) => {
      const s = req.socket;
      const c = s.getPeerCertificate(true);
      res.resume(); res.on('end', () => {
        console.log(`${label}: reused=${s.isSessionReused()} raw=${c && c.raw ? c.raw.length : 'NONE'}`);
        resolve();
      });
    });
    req.on('error', (e) => { console.log(`${label}: error ${e.message}`); resolve(); });
    req.end();
  });
}
// A: keep-alive off the socket between requests by destroying the agent's pooled sockets.
const a = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false, maxCachedSessions: 4 });
await probe('A#1 (maxCachedSessions:4)', a);
a.destroy();
await probe('A#2 after agent.destroy()', a);
