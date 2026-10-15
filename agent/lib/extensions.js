import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Read-only inventory of installed browser extensions. Nothing is written, nothing outside the
// browser's own profile directories is read, and the file hash gate means a large "Secure
// Preferences" is parsed about once a day per device rather than on every heartbeat.

const CHROMIUM_BROWSERS = [
  { browser: 'chrome', dir: ['Google', 'Chrome', 'User Data'] },
  { browser: 'brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { browser: 'edge', dir: ['Microsoft', 'Edge', 'User Data'] },
];
const FIREFOX_DIR = ['Mozilla', 'Firefox', 'Profiles'];

// Extensions an inventory should not report as installed-and-enabled: these are shipped with the
// browser and carry no third-party permissions. They are skipped to keep the dashboard signal
// about what the user added.
const IGNORED_IDS = new Set([
  'nmmhkkegccagdldgiimedpiccmgmieda', // Google Wallet
  'fheoggkfdfchfphceeifdbepaooicaho', // Chrome Website Verifier
]);

function fileGist(file) {
  try {
    const st = statSync(file);
    const buf = readFileSync(file);
    return `${st.mtimeMs.toFixed(0)}|${st.size}|${createHash('sha256').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}

function chromiumProfiles(userDataDir) {
  const out = [];
  if (!existsSync(userDataDir)) return out;
  for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Local State / Crashpad / GrShaderCache etc. are not profiles; a profile has Preferences.
    if (!/^(Default|Profile \d+)$/.test(entry.name)) continue;
    if (!existsSync(path.join(userDataDir, entry.name, 'Preferences'))) continue;
    out.push(entry.name);
  }
  return out;
}

function readChromiumSettings(profileDir) {
  // Secure Preferences is the signed copy and can exceed 5 MiB; Preferences is the unsigned one.
  // Try in that order and stop at the first file that actually carries extension settings.
  for (const name of ['Secure Preferences', 'Preferences']) {
    const file = path.join(profileDir, name);
    if (!existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const settings = doc?.extensions?.settings;
    if (settings && typeof settings === 'object') return { settings, file };
  }
  return null;
}

function mapChromium(extId, entry) {
  const contents = entry?.contents ?? {};
  const state = entry?.state;
  const fromManifest = contents.name ?? entry?.path ?? extId;
  const permissions = Array.isArray(entry?.permissions)
    ? entry.permissions
    : Array.isArray(contents?.permissions) ? contents.permissions : [];
  let source = 'unknown';
  if (typeof entry?.path === 'string' && entry.path !== '') source = 'sideload';
  else if (entry?.fromWebstore !== false && (entry?.state === 1 || state === undefined)) source = 'webstore';
  else if (entry?.location === 10) source = 'builtin';
  if (typeof entry?.source === 'string' && ['webstore', 'local', 'sideload'].includes(entry.source)) {
    source = entry.source;
  }
  return {
    ext_id: extId,
    name: String(fromManifest).slice(0, 512),
    version: contents.version ? String(contents.version).slice(0, 128) : null,
    source,
    permissions: permissions.slice(0, 64).map((p) => String(p).slice(0, 256)),
    // Chrome state: 1 = enabled, 0 = disabled, anything else (or missing) is not enabled.
    enabled: entry?.enabled === true || state === 1,
  };
}

function collectChromium(localAppData, overrideRoot) {
  const results = [];
  for (const { browser, dir } of CHROMIUM_BROWSERS) {
    const userData = overrideRoot
      ? path.join(overrideRoot, 'Local', ...dir)
      : path.join(localAppData, ...dir);
    if (!existsSync(userData)) continue;
    for (const profile of chromiumProfiles(userData)) {
      const profileDir = path.join(userData, profile);
      const found = readChromiumSettings(profileDir);
      if (!found) continue;
      const extensions = [];
      for (const [extId, entry] of Object.entries(found.settings)) {
        if (IGNORED_IDS.has(extId)) continue;
        const mapped = mapChromium(extId, entry);
        if (mapped) extensions.push(mapped);
      }
      results.push({
        browser, profile, extensions,
        sourceFile: found.file, gist: fileGist(found.file),
      });
    }
  }
  return results;
}

function collectFirefox(appData, overrideRoot) {
  const results = [];
  const profilesRoot = overrideRoot
    ? path.join(overrideRoot, 'Roaming', ...FIREFOX_DIR)
    : path.join(appData, ...FIREFOX_DIR);
  if (!existsSync(profilesRoot)) return results;
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(profilesRoot, entry.name, 'extensions.json');
    if (!existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const addons = Array.isArray(doc?.addons) ? doc.addons : [];
    const extensions = [];
    for (const addon of addons) {
      if (!addon || IGNORED_IDS.has(addon.id)) continue;
      // `appDisabled`/`userDisabled` are Firefox's own enabled flags.
      const enabled = addon.appDisabled !== true && addon.userDisabled !== true;
      extensions.push({
        ext_id: String(addon.id).slice(0, 256),
        name: String(addon.name ?? addon.id).slice(0, 512),
        version: addon.version ? String(addon.version).slice(0, 128) : null,
        source: addon.builtIn ? 'builtin' : (String(addon.rootURI ?? '').startsWith('file:') ? 'local' : 'webstore'),
        permissions: Array.isArray(addon.permissions)
          ? addon.permissions.slice(0, 64).map((p) => String(p).slice(0, 256)) : [],
        enabled,
      });
    }
    if (extensions.length === 0) continue;
    results.push({
      browser: 'firefox',
      profile: entry.name,
      extensions,
      sourceFile: file,
      gist: fileGist(file),
    });
  }
  return results;
}

// Returns one entry per (browser, profile) that has extension data, each carrying a `gist` the
// caller stores so an unchanged profile is not re-uploaded.
export function readExtensionInventory({ localAppData, appData, rootOverride } = {}) {
  const la = localAppData ?? process.env.LOCALAPPDATA ?? '';
  const ro = appData ?? process.env.APPDATA ?? '';
  const out = [];
  // A missing browser is the normal case, not an error: an absent directory simply contributes
  // nothing, and a browser with no readable preferences file contributes nothing either.
  try { out.push(...collectChromium(la, rootOverride)); } catch { /* never crash the agent */ }
  try { out.push(...collectFirefox(ro, rootOverride)); } catch { /* never crash the agent */ }
  return out;
}

export { fileGist };
