import { request } from 'node:https';
const PORT = 8443;
function call(method, p, { body, headers = {} } = {}) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = request({ host: '127.0.0.1', port: PORT, path: p, method, rejectUnauthorized: false,
      headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, (s) => {
      const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res({ status: s.statusCode, headers: s.headers, text: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', rej); if (payload) r.write(payload); r.end();
  });
}
const login = await call('POST', '/api/login', { body: { account: 'itadmin', password: 'demo-pass-42' } });
const cookie = login.headers['set-cookie'][0].split(';')[0];
const H = { cookie };
const anon = await call('GET', '/');
console.log('GET / anon            ->', anon.status, anon.headers.location ?? '');
const paths = ['/', '/login', '/screenshots', '/extensions', '/clipboard', '/audit', '/health', '/policy', '/app.css', '/app.js',
  '/fragments/pending', '/fragments/devices', '/fragments/health', '/fragments/shots', '/fragments/extensions', '/fragments/clipboard', '/fragments/audit',
  '/../server/lib/schema.sql', '/screenshots/latest.png', '/nope'];
for (const p of paths) {
  const r = await call('GET', p, { headers: p.startsWith('/app') || p === '/login' ? {} : H });
  const marker = /<section|<style|css|Error|error/.test(r.text.slice(0, 200)) ? r.text.slice(0, 0) : '';
  console.log(`GET ${p.padEnd(24)} -> ${r.status} ${String(r.headers['content-type']).split(';')[0].padEnd(10)} ${r.text.length}b ${r.headers.etag ?? ''} ${r.headers['content-security-policy'] ? 'CSP' : 'NO-CSP'}`);
  if (r.status >= 500) console.log('   ', r.text.slice(0, 300));
}
const dev = (await call("GET", "/api/devices", { headers: H })).text;
const ids = JSON.parse(dev).items.map((d) => d.id);
for (const id of ids) {
  const r = await call('GET', `/devices/${id}`, { headers: H });
  console.log(`GET /devices/${id} -> ${r.status} ${r.text.length}b`);
}
// fragment revalidation must be free: 304 with a zero-length body
const first = await call('GET', '/fragments/devices', { headers: H });
const again = await call('GET', '/fragments/devices', { headers: { ...H, 'if-none-match': first.headers.etag } });
console.log('fragment revalidate   ->', again.status, `${again.text.length}b`, 'etag', first.headers.etag);
