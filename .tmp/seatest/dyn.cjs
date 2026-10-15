const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const target = path.join(process.cwd(), 'esmmod.mjs');
  const m = await import(pathToFileURL(target).href);
  console.log('dynamic import of on-disk ESM worked:', m.go());
})().catch((e) => console.log('FAILED:', e.code || '', e.message));
