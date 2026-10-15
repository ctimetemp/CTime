// Builds the single-file Windows agent setup with no downloaded tooling.
//
//   node scripts/build-agent-exe.js
//   node scripts/build-agent-exe.js --out dist --name CTTImeSetup.exe
//
// How it works: `node --build-sea` grafts a CommonJS main script onto a copy of the Node binary.
// Everything else this build carries -- the agent's source, the PowerShell installer, and the
// runtime the scheduled task will use -- is embedded as gzip assets and unpacked as ordinary files.
// The agent is never compiled or minified, so what runs on a device is still something the device
// user, their IT department and their antivirus can open and read.
//
// Zero dependencies: Node's own zlib, fs and the --build-sea flag. Nothing is fetched, nothing is
// installed, so this works on a machine that has never seen the internet.
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

function fail(message) {
  process.stderr.write(`! ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'dist'), name: 'CTTImeSetup.exe', runtime: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--runtime') out.runtime = path.resolve(argv[++i]);
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') { out.help = true; }
    else fail(`unknown option ${a}`);
  }
  return out;
}

// Collects the files that go inside the exe. Keys are the paths the launcher will write, relative
// to the state directory, so the layout on the device is decided here and nowhere else.
function collectFiles() {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.js')) files.set(`f/setup/agent/${prefix}${entry.name}`, abs);
    }
  };
  walk(path.join(ROOT, 'agent'), '');
  files.set('f/setup/package.json', path.join(ROOT, 'package.json'));
  // The installer is the disclosure surface, and the launcher is the thing inside the binary:
  // shipping both as plain text means nobody has to take the build on trust.
  for (const script of ['install.ps1', 'uninstall.ps1', 'agent-setup-launcher.cjs', 'build-agent-exe.js']) {
    files.set(`f/setup/scripts/${script}`, path.join(ROOT, 'scripts', script));
  }
  return files;
}

function pickRuntime(explicit) {
  const candidate = explicit ?? process.execPath;
  if (!existsSync(candidate)) fail(`no Node binary at ${candidate}`);
  const size = statSync(candidate).size;
  // A version manager's shim is a few hundred KB and forwards to the real binary. Copying it would
  // produce an exe whose runtime silently changes whenever the user switches Node versions, so the
  // genuine article is required.
  if (size < 20 * 1024 * 1024) {
    fail(`${candidate} is ${size} bytes -- that is a launcher or shim, not a Node binary. `
      + 'Point --runtime at the real node.exe (for nvm users, inside its installs\\v<version> folder) '
      + 'or at an official Node download.');
  }
  return candidate;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('node scripts/build-agent-exe.js [--out dist] [--name CTTImeSetup.exe] [--runtime <node.exe>] [--keep]\n');
    return 0;
  }
  const runtime = pickRuntime(opts.runtime);
  const files = collectFiles();
  const agentDir = path.join(ROOT, 'agent');
  if (!existsSync(path.join(agentDir, 'cli.js'))) fail('no agent/cli.js to package');

  const stage = path.join(ROOT, '.tmp', 'build-sea');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, 'assets'), { recursive: true });

  const assets = {};
  const manifest = [];
  for (const [key, abs] of [...files].sort()) {
    const data = readFileSync(abs);
    const gz = gzipSync(data, { level: 9 });
    const assetPath = path.join(stage, 'assets', `${sha256(Buffer.from(key))}.gz`);
    writeFileSync(assetPath, gz);
    assets[key] = assetPath;
    manifest.push({ writes: key.slice('f/'.length), bytes: data.length, sha256: sha256(data) });
  }

  const runtimeData = readFileSync(runtime);
  const runtimeGz = path.join(stage, 'assets', 'runtime.gz');
  writeFileSync(runtimeGz, gzipSync(runtimeData, { level: 9 }));
  assets['f/runtime/node.exe'] = runtimeGz;
  manifest.push({ writes: 'runtime/node.exe', bytes: runtimeData.length, sha256: sha256(runtimeData) });

  const mainScript = path.join(ROOT, 'scripts', 'agent-setup-launcher.cjs');
  const exePath = path.join(opts.out, opts.name);
  mkdirSync(opts.out, { recursive: true });
  const config = {
    main: mainScript,
    output: exePath,
    assets,
    disableExperimentalSEAWarning: true,
  };
  const configPath = path.join(stage, 'sea.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  process.stdout.write(`building ${exePath}\n`);
  process.stdout.write(`  runtime   ${runtime} (${(runtimeData.length / 1048576).toFixed(1)} MB, sha256 ${sha256(runtimeData).slice(0, 16)}...)\n`);
  process.stdout.write(`  files     ${manifest.length}\n`);
  const build = spawnSync(process.execPath, ['--build-sea', configPath], { encoding: 'utf8' });
  if (build.status !== 0) {
    process.stderr.write(`${build.stdout ?? ''}${build.stderr ?? ''}\n`);
    fail('node --build-sea failed');
  }
  if (!existsSync(exePath)) fail(`build reported success but ${exePath} is not there`);

  const exeBytes = statSync(exePath).size;
  const digest = sha256(readFileSync(exePath));
  writeFileSync(`${exePath}.sha256`, `${digest}  ${opts.name}\n`);
  writeFileSync(path.join(opts.out, 'PACKAGED-FILES.txt'), [
    `CTTIme agent setup build`,
    `built at   ${new Date().toISOString()}`,
    `runtime    ${runtime}`,
    `executable ${opts.name} (${exeBytes} bytes)`,
    `sha256     ${digest}`,
    '',
    'Files this executable writes into the state directory, with the sha256 of each as packaged.',
    'Rebuild from a copy of this repository and compare: node scripts/build-agent-exe.js',
    '',
    ...manifest.map((m) => `${String(m.bytes).padStart(10)}  ${m.sha256}  ${m.writes}`),
    '',
  ].join('\n'));

  if (!opts.keep) rmSync(path.join(stage, 'assets'), { recursive: true, force: true });
  process.stdout.write(`\nbuilt ${opts.name}  ${(exeBytes / 1048576).toFixed(1)} MB\n`);
  process.stdout.write(`  sha256 ${digest}\n`);
  process.stdout.write(`  manifest ${path.join(opts.out, 'PACKAGED-FILES.txt')}\n`);
  process.stdout.write(`\nhand out one file, run it on the device:\n`);
  process.stdout.write(`  CTTImeSetup.exe install --host <collector-ip> --pin <64-hex>\n`);
  process.stdout.write(`  CTTImeSetup.exe install --host <collector-ip> --pin <64-hex> --acknowledge\n`);
  process.stdout.write(`\nmacOS and Linux binaries cannot be produced from this machine, and the agent\n`);
  process.stdout.write(`only knows how to capture a screen, read the clipboard and seal a token on\n`);
  process.stdout.write(`Windows -- see docs/PACKAGING.md.\n`);
  return 0;
}

main();
