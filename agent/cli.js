import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runAgent } from './index.js';
import { AGENT_VERSION } from './version.js';
import { resolveStateDir, paths } from './lib/state.js';

// The agent is a normal, named, discoverable program. `--help` works, the state directory is
// documented, and no flag hides any of it. `--resident` suppresses the console window the scheduled
// task would otherwise leave on the desktop, and nothing else: the task stays named, the code stays
// plain readable files, and config.json, agent.log and `what-collects` all keep saying it runs. An
// installer that wanted real invisibility would need code that does not exist here.

const USAGE = `CTTIme agent ${AGENT_VERSION}

  node agent/cli.js <command> [options]

Commands
  run                 Enroll if needed, then collect and flush on the server's schedule.
  one-shot            Fetch policy, take one of each sample, flush, and exit. For verification.
  status              Print local state: enrollment, spool depth, policy in effect, dropped count.
  what-collects       Print exactly what this device collects and how often it leaves.
  check               Verify connectivity, pin, notice and enrollment state without collecting.

Options
  --host <addr>       Collector host or LAN IP.                (required for run/one-shot/check)
  --port <n[,n]>      Collector port(s), tried in order.      (default 8443)
  --pin <hex64>       SHA-256 fingerprint of the collector certificate. Required; no fallback.
  --state-dir <dir>   Override %PROGRAMDATA%\\CTTIme. Use for testing on a dev box.
  --acknowledge-by <name>
                      Supply the acknowledgment non-interactively. The notice text is still
                      printed first unless --no-notice.
  --no-notice         Do not print the notice text when acknowledging non-interactively.
  --interactive       Prompt for acknowledgment on stdin.
  --resident          Scheduled-task mode: opens no console window. Affects the window only -- the
                      named task, config.json, agent.log and what-collects are unchanged, and a run
                      without it (yours, by hand) keeps its window.
  --verbose           Echo the local log to stdout.
`;

function parseArgs(argv) {
  const out = { command: argv[0] ?? 'help', port: 8443, stateDir: null, verbose: false, showNotice: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--host': out.host = argv[++i]; break;
      case '--port': out.ports = String(argv[++i]).split(/[,;\s]+/).filter(Boolean).map(Number); out.port = out.ports[0]; break;
      case '--pin': out.pin = argv[++i]; break;
      case '--state-dir': out.stateDir = argv[++i]; break;
      case '--acknowledge-by': out.acknowledgeBy = argv[++i]; break;
      case '--no-notice': out.showNotice = false; break;
      case '--interactive': out.interactive = true; break;
      case '--resident': out.resident = true; break;
      case '--verbose': out.verbose = true; break;
      case '--help': case '-h': out.command = 'help'; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return out;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === 'help') { process.stdout.write(USAGE); return 0; }
  if (opts.command === 'what-collects') return whatCollects(opts);
  if (opts.command === 'status') return status(opts);
  if (['run', 'one-shot', 'check'].includes(opts.command)) {
    if (!opts.host) { process.stderr.write('! --host is required\n'); return 2; }
    if (!opts.pin) { process.stderr.write('! --pin is required. The collector prints it at startup.\n'); return 2; }
    if (opts.command === 'one-shot') opts.oneShot = true;
    if (opts.command === 'check') opts.check = true;
    const result = await runAgent(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A failed pre-flight has to leave a non-zero status or a script reading it sees success.
    return result.status === 'check_failed' ? 1 : 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

function whatCollects(opts) {
  const p = paths(resolveStateDir(opts.stateDir));
  if (!existsSync(p.config)) {
    process.stdout.write('Not installed or never run on this machine: no config.json yet.\n');
    process.stdout.write(`Expected at ${p.config}\n`);
    return 1;
  }
  const cfg = JSON.parse(readFileSync(p.config, 'utf8'));
  process.stdout.write('What this agent collects on this device\n');
  process.stdout.write('=========================================\n');
  process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n\n`);
  process.stdout.write(`Local log:      ${p.log}\n`);
  process.stdout.write(`Spool:          ${p.spool}\n`);
  process.stdout.write(`Scheduled task: CTTIme Endpoint Visibility (visible in schtasks /query)\n`);
  process.stdout.write(`Uninstall:      scripts/uninstall.ps1\n`);
  return 0;
}

async function status(opts) {
  const p = paths(resolveStateDir(opts.stateDir));
  const identity = existsSync(p.identity) ? JSON.parse(readFileSync(p.identity, 'utf8')) : null;
  const policyFile = existsSync(p.policy) ? JSON.parse(readFileSync(p.policy, 'utf8')) : null;
  const spoolDir = existsSync(p.spool) ? p.spool : null;
  // Whether the agent actually told the person at this keyboard something. Read from the file the
  // notifier writes, so it is true after the process has left and cannot be claimed from memory.
  const noticeFile = path.join(p.pending, 'notifications.json');
  let notices = null;
  try { notices = existsSync(noticeFile) ? JSON.parse(readFileSync(noticeFile, 'utf8')) : null; } catch { notices = null; }
  process.stdout.write(`${JSON.stringify({
    state_dir: p.root,
    installed: existsSync(p.config),
    enrolled: Boolean(identity?.device_id),
    device_id: identity?.device_id ?? null,
    has_sealed_token: existsSync(p.token),
    policy_etag: policyFile?.etag ?? null,
    policy_keys: policyFile ? Object.keys(policyFile.values ?? {}).length : 0,
    spool_dir: spoolDir,
    notices_to_device_user: notices
      ? { shown: notices.sent ?? 0, failed: notices.failed ?? 0, last: notices.history?.[0] ?? null }
      : { shown: 0, failed: 0, last: null },
  }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      // The message is printed to a console the device user can see, so it is also a disclosure
      // surface: report the failure, never a payload.
      process.stderr.write(`agent error: ${err.code ?? 'internal'} ${err.detail ?? err.message}\n`);
      process.exitCode = 1;
    });
}
