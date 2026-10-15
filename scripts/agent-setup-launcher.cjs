// Embedded main script of the single-file Windows build (see scripts/build-agent-exe.js).
//
// What this is: a self-extractor. It writes the Node runtime and the agent's source -- which stay
// plain, readable .js files on disk, deliberately NOT compiled into this binary -- into the state
// directory, then runs the same scripts\install.ps1 that the folder-copy install uses. All of the
// disclosure behaviour (ABOUT.txt, the visible task name, the consent prompt, the notice) lives in
// that installer, so this file adds no policy of its own and cannot weaken any.
//
// Why not a flattened single file: `node --build-sea` embeds only a CommonJS main, and a SEA
// cannot dynamic-import on-disk ESM (ERR_UNKNOWN_BUILTIN_MODULE). Producing one opaque blob would
// mean either a third-party bundler, which the project's zero-dependency rule forbids, or
// rewriting the agent out of ESM. Both trade a readable audit trail for a smaller hand-out file,
// and this software is watched by the people it watches.
'use strict';

const sea = require('node:sea');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ASSET_PREFIX = 'f/';

function usage() {
  process.stdout.write([
    'CTTIme agent setup',
    '',
    '  CTTImeSetup.exe install --host <addr> --pin <64hex> [--port 8443] [--state-dir <dir>]',
    '                         [--acknowledge] [--dry-run]',
    '  CTTImeSetup.exe unpack [--state-dir <dir>]        (files only, installs nothing)',
    '  CTTImeSetup.exe --help',
    '',
    'Installs nothing until you give it the collector address and its certificate pin, and',
    'collects nothing until the device user acknowledges the monitoring notice in person.',
    'Everything it writes lands in one folder that uninstall.ps1 removes.',
    '',
  ].join('\n'));
}

function fail(message) {
  process.stderr.write(`! ${message}\n`);
  process.exit(1);
}

// Pass-through flags for install.ps1, mapped from the lowercase CLI style users type here to the
// PowerShell parameter names, so there is exactly one installer to audit.
const INSTALL_FLAG_MAP = {
  '--host': '-CollectorHost',
  '--port': '-CollectorPort',
  '--pin': '-Pin',
  '--state-dir': '-StateDir',
  '--task-name': '-TaskName',
  '--acknowledge': '-Acknowledge',
  '--dry-run': '-DryRun',
};

function parseArgs(argv) {
  const command = argv[0] ?? '--help';
  const values = new Map();
  const switches = [];
  for (let i = 1; i < argv.length; i++) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) fail(`unexpected argument ${token}`);
    const eq = token.indexOf('=');
    if (eq !== -1) {
      values.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      values.set(token, next);
      i++;
    } else {
      switches.push(token);
    }
  }
  return { command, values, switches };
}

function stateDirFrom(values) {
  const explicit = values.get('--state-dir');
  if (explicit) return path.resolve(explicit);
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
  return path.join(programData, 'CTTIme');
}

// Asset keys are produced by the build from this repository's file tree, but the exe may be
// tampered with after that, so every key is treated as untrusted input: no absolute paths, no
// parent traversal, nothing outside the destination.
function targetFor(key, dest) {
  if (!key.startsWith(ASSET_PREFIX)) return null;
  const rel = key.slice(ASSET_PREFIX.length).replace(/\\/g, '/');
  if (rel === '' || rel.includes('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null;
  const abs = path.resolve(dest, rel);
  const rootWithSep = dest.endsWith(path.sep) ? dest : dest + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

function unpack(dest) {
  const keys = sea.getAssetKeys();
  if (!keys.length) fail('this executable carries no embedded files; it is not a CTTIme setup build');
  const written = [];
  for (const key of keys) {
    const target = targetFor(key, dest);
    if (!target) fail(`refusing to write asset with an unsafe path: ${key}`);
    const raw = Buffer.from(sea.getRawAsset(key));
    // Every asset is stored compressed by the build, so there is no branch here to get wrong.
    let data;
    try { data = gunzipSync(raw); } catch { fail(`embedded file is corrupt, this build is damaged: ${key}`); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const digest = createHash('sha256').update(data).digest('hex');
    // A file already matching byte-for-byte is left alone, so re-running setup never churns a
    // working install or resets its timestamps.
    let unchanged = false;
    try {
      unchanged = digest === createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    } catch { /* absent: write it */ }
    if (!unchanged) {
      fs.writeFileSync(target, data);
      written.push(path.relative(dest, target));
    }
  }
  return { dest, written, total: keys.length };
}

function runInstaller(dest, values, switches) {
  const script = path.join(dest, 'setup', 'scripts', 'install.ps1');
  if (!fs.existsSync(script)) fail(`installer missing after unpack: ${script}`);
  const runtime = path.join(dest, 'runtime', 'node.exe');
  if (!fs.existsSync(runtime)) fail(`bundled runtime missing after unpack: ${runtime}`);

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  for (const [flag, param] of Object.entries(INSTALL_FLAG_MAP)) {
    if (values.has(flag)) args.push(param, values.get(flag));
    else if (switches.includes(flag)) args.push(param);
  }
  // The runtime this build carries is always used: PATH resolution would leave the installed task
  // pointing at whatever Node the machine happens to have, which is what this build exists to avoid.
  args.push('-NodePath', runtime, '-SourceDir', path.join(dest, 'setup', 'agent'));
  if (!values.has('--state-dir')) args.push('-StateDir', dest);

  process.stdout.write(`\nRunning ${script}\n`);
  // Node quotes each argument for us. Verbatim argument passing was tried first and it breaks on a
  // task name containing spaces, which PowerShell then reads as separate parameters.
  const child = spawnSync('powershell.exe', args, { stdio: 'inherit' });
  if (child.error) fail(`could not start PowerShell: ${child.error.message}`);
  if (child.signal) fail(`installer was interrupted (${child.signal})`);
  return child.status ?? 1;
}

function main() {
  if (!sea.isSea()) fail('run this build through node instead: scripts\\build-agent-exe.js');
  const { command, values, switches } = parseArgs(process.argv.slice(2));
  if (command === '--help' || command === '-h') { usage(); return 0; }
  if (command !== 'install' && command !== 'unpack') fail(`unknown command ${command}`);

  const dest = stateDirFrom(values);
  // Refusing a drive root here matters more than it looks: unpack would otherwise drop a runtime
  // and a task-registered installer straight into C:\.
  const parsed = path.parse(dest);
  if (!parsed.dir || parsed.dir === parsed.root) fail(`refusing to install into a drive root: ${dest}`);

  const result = unpack(dest);
  process.stdout.write(`CTTIme agent setup\n  unpacked to   ${result.dest}\n`);
  process.stdout.write(`  files written ${result.written.length} of ${result.total} (rest already current)\n`);
  for (const rel of result.written) process.stdout.write(`    ${rel}\n`);
  process.stdout.write('  the agent source is plain .js text: open it and read it.\n');

  if (command === 'unpack') return 0;
  if (!values.has('--host') || !values.has('--pin')) {
    process.stdout.write('\nNot installed: --host and --pin are both required, and there is no default.\n');
    process.stdout.write('The collector prints its pin at startup.\n');
    return 2;
  }
  return runInstaller(dest, values, switches);
}

try {
  process.exitCode = main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
