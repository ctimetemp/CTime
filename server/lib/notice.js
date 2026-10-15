import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK = path.resolve(here, '../../docs/NOTICE-TEMPLATE.md');

const COLLECTS = ['screenshots', 'extension_inventory', 'clipboard_metrics', 'screen_state'];

// Notice wording is authored server-side and served from the database when an admin has
// published a new version. The agent never contains legal text, so a wording change cannot
// require re-signing and redeploying every endpoint.
// The template file carries authoring guidance as well as the employee-facing wording. Only the
// region between the markers is ever served to a device.
function extractNotice(markdown) {
  const m = /<!-- NOTICE-BEGIN[\s\S]*?-->\r?\n([\s\S]*?)\r?\n<!-- NOTICE-END -->/.exec(markdown);
  return (m ? m[1] : markdown).trim();
}

export function createNotice(db) {
  let fileCache = null;
  return {
    text() {
      const stored = db.prepare("SELECT value FROM policy WHERE key = 'notice_text'").get();
      if (stored?.value) return stored.value;
      if (fileCache === null) {
        try { fileCache = extractNotice(readFileSync(FALLBACK, 'utf8')); } catch { fileCache = ''; }
      }
      return fileCache;
    },
    collects() { return COLLECTS; },
    setVersion(version, text, actor) {
      const now = "datetime('now')";
      db.prepare(`INSERT INTO policy (key, value, updated_at, updated_by)
        VALUES ('notice_version', ?, ${now}, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`).run(version, actor);
      db.prepare(`INSERT INTO policy (key, value, updated_at, updated_by)
        VALUES ('notice_text', ?, ${now}, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`).run(text, actor);
    },
  };
}
