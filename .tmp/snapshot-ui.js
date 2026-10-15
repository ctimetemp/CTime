// Scratch: export the dashboard's rendered pages to file:// so a browser can look at them without
// accepting a self-signed certificate. Byte-for-byte what the collector served, with links and
// media rewritten to local paths.
import { request } from 'node:https';
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const PORT = 8443;
const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'uicheck');
const SHOTS = path.join(HERE, 'demo', 'screenshots');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'shots'), { recursive: true });

function raw(method, p, { body, headers = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = request({ host: '127.0.0.1', port: PORT, path: p, method, rejectUnauthorized: false,
      headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, (s) => {
      const c = []; s.on('data', (d) => c.push(d));
      s.on('end', () => resolveP({ status: s.statusCode, headers: s.headers, buf: Buffer.concat(c) }));
    });
    r.on('error', rejectP); if (payload) r.write(payload); r.end();
  });
}
const get = (p, headers = {}) => raw('GET', p, { headers });
const text = async (p, headers) => (await get(p, headers)).buf.toString('utf8');

const res = await raw('POST', '/api/login', { body: { account: 'itadmin', password: 'demo-pass-42' } });
const cookie = res.headers['set-cookie'][0].split(';')[0];
const H = { cookie };

const PAGES = {
  index: '/', screenshots: '/screenshots', extensions: '/extensions', clipboard: '/clipboard',
  audit: '/audit', health: '/health', policy: '/policy', login: '/login',
};
const devices = JSON.parse(await text('/api/devices?limit=100', H)).items;
for (const d of devices) PAGES[`device-${d.hostname}`] = `/devices/${d.id}`;

const nameFor = new Map(Object.entries(PAGES).map(([n, p]) => [p, `${n}.html`]));

const shots = JSON.parse(await text('/api/screenshots?limit=100', H)).items;
for (const s of shots) {
  const src = path.join(SHOTS, s.device_id.slice(0, 8), `${s.event_id}.png`);
  if (existsSync(src)) copyFileSync(src, path.join(OUT, 'shots', `${s.id}.png`));
}

copyFileSync(path.join(HERE, '..', 'server', 'public', 'app.css'), path.join(OUT, 'app.css'));
copyFileSync(path.join(HERE, '..', 'server', 'public', 'app.js'), path.join(OUT, 'app.js'));

for (const [name, p] of Object.entries(PAGES)) {
  let html = await text(p, p === '/login' ? {} : H);
  html = html
    .replaceAll(/\/media\/screenshots\/(\d+)/g, (_m, id) => `shots/${id}.png`)
    .replaceAll('href="/app.css"', 'href="app.css"')
    .replaceAll('src="/app.js"', 'src="app.js"')
    .replaceAll(/data-poll="(\/[^"]*)"/g, 'data-livepoll="$1"')
    .replaceAll(/href="(\/[^"]*)"/g, (_m, href) => `href="${nameFor.get(href) ?? 'index.html'}"`);
  writeFileSync(path.join(OUT, `${name}.html`), html);
  console.log(`${name.padEnd(20)} ${html.length}b`);
}
console.log('\nwrote', OUT);
