// Saves the collector's server-rendered pages, with their real stylesheet, so the redesigned
// dashboard can be looked at in a browser. The HTML is produced by render.js on the server, so what
// lands here is exactly what an admin's browser receives -- only the self-signed certificate keeps
// a headless browser from loading the live URL itself.
import { request } from 'node:https';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 8470);
const OUT = path.resolve('.tmp/uicheck');
mkdirSync(OUT, { recursive: true });

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, rejectUnauthorized: false, servername: undefined },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
    req.on('error', reject);
    req.end();
  });
}

function post(url, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body), ...headers }, rejectUnauthorized: false,
      servername: undefined }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Assets are referenced from the site root, which file:// would resolve against the drive.
const inline = (html) => html
  .replace('href="/app.css"', 'href="app.css"')
  .replace('src="/app.js"', 'src="app.js"');

const login = await post(`https://127.0.0.1:${PORT}/api/login`,
  { account: 'itadmin', password: 'review-pass-12' });
if (login.status !== 200) throw new Error(`login returned ${login.status}: ${login.body.slice(0, 120)}`);
const cookie = (login.headers['set-cookie'] ?? [''])[0].split(';')[0];

for (const name of ['overview', 'devices', 'pending', 'health', 'policy', 'audit']) {
  const page = { overview: '/', devices: '/devices', pending: '/pending', health: '/health',
    policy: '/policy', audit: '/audit' }[name];
  const r = await get(`https://127.0.0.1:${PORT}${page}`, { cookie });
  writeFileSync(path.join(OUT, `${name}.html`), inline(r.body));
  console.log(`${name.padEnd(9)} ${page.padEnd(9)} ${r.status}  ${r.body.length} bytes`);
}

const list = JSON.parse((await get(`https://127.0.0.1:${PORT}/api/devices`, { cookie })).body).items;
const seen = new Set();
for (const d of list) {
  const v = await get(`https://127.0.0.1:${PORT}/api/devices/${d.id}/verify`, { cookie });
  if (v.status !== 200) { console.log(`verify ${d.hostname} -> ${v.status}`); continue; }
  const report = JSON.parse(v.body);
  if (seen.has(report.verdict)) continue;
  seen.add(report.verdict);
  const page = await get(`https://127.0.0.1:${PORT}/devices/${d.id}`, { cookie });
  const file = `device-${report.verdict}.html`;
  writeFileSync(path.join(OUT, file), inline(page.body));
  const done = (report.steps ?? []).filter((s) => s.done).length;
  console.log(`${file.padEnd(24)} ${JSON.stringify({ verdict: report.verdict,
    headline: report.headline, steps: `${done}/${(report.steps ?? []).length}` })}`);
}

copyFileSync(path.join(OUT, 'overview.html'), path.join(OUT, 'index.html'));
console.log(`\nopen file://${OUT.replace(/\\/g, '/')}index.html`);
