import { readFileSync, writeFileSync } from 'node:fs';
import { ALERTS } from '../agent/lib/notify.js';
const text = readFileSync(new URL('../agent/lib/notify.js', import.meta.url), 'utf8');
const script = /const SCRIPT = String\.raw`([\s\S]*?)`;/.exec(text)[1];
writeFileSync(new URL('./node-notify-dump.json', import.meta.url),
  JSON.stringify({ alerts: ALERTS, script }));
console.log('dumped script chars:', script.length);
