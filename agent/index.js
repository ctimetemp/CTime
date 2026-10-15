import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AGENT_VERSION } from './version.js';
import {
  resolveStateDir, paths, ensureLayout, readJsonFile, writeJsonFile, deviceIdentity,
} from './lib/state.js';
import { createSpool } from './lib/spool.js';
import { createPolicyState } from './lib/policy.js';
import { createTransport } from './lib/transport.js';
import { sealToken, openToken } from './lib/token.js';
import { deviceFingerprint } from './lib/identity.js';
import { createCapturer } from './lib/screenshot.js';
import { createClipboardSampler } from './lib/clipboard.js';
import { createProducers } from './lib/producers.js';
import { createFlusher } from './lib/flush.js';
import { createNotifier } from './lib/notify.js';
import { createConnectionWatch } from './lib/connection.js';
import { hideResidentConsole } from './lib/console.js';
import { HttpError } from './lib/errors.js';

// The agent process. Disclosure is structural, so this file owns three things beyond collection:
// the plaintext config.json the device user can open, the local log, and the rule that nothing is
// captured before a token exists.
export async function runAgent(opts) {
  const stateDir = resolveStateDir(opts.stateDir);
  const p = paths(stateDir);
  ensureLayout(p);

  const log = makeLogger(p.log, opts.verbose);
  const identity = deviceIdentity();
  const ident = deviceFingerprint(stateDir);
  const stored = readJsonFile(p.identity, {});

  const transport = createTransport({ host: opts.host, port: opts.port, ports: opts.ports, pin: opts.pin });
  const policy = createPolicyState({ file: p.policy, onWarn: log });
  const spool = createSpool({ dir: p.spool, maxBytes: policy.values.spool_max_bytes, onWarn: log });

  let tokenValue = openToken(p.token);
  const token = {
    headers: () => (tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}),
    present: () => Boolean(tokenValue),
    set: (v) => { tokenValue = v; },
  };
  const deviceId = () => stored.device_id ?? PLACEHOLDER_UUID;

  // createCapturer returns { capture, probe, ... }, and producers calls the injected capture
  // directly, so handing it the object made every screenshot tick throw.
  const capturer = createCapturer({ workDir: p.pending, onWarn: log });
  const sampleClipboard = createClipboardSampler({ workDir: p.pending, onWarn: log });
  const producers = createProducers({ spool, policy, deviceId: deviceId,
    capture: capturer.capture, sampleClipboard, log });
  producers.loadGists(stateDir);

  // flusher and scheduler refer to each other (a policy change re-times the scheduler, and the
  // scheduler drives the flusher). Declared in this order with a late-bound reference so neither
  // reads the other during construction.
  let scheduler = null;
  const flusher = createFlusher({
    transport, spool, policy, deviceId, token, log,
    onPolicy: () => {
      scheduler?.retime(policy.values);
      spool.enforceCap();
      writeDisclosureConfig(p, policy, opts, stateDir, ident);
    },
  });
  // The device user is told, on their own screen, when the link to the collector changes. It is
  // wired to the heartbeat outcome because that is the one request a resident agent makes whether
  // or not there is anything to send, so "cannot reach the collector" and "nothing to report" stay
  // distinct. one-shot and check never reach here: a verification command must not pop a balloon.
  const notifier = createNotifier({ workDir: p.pending, log });
  const watch = createConnectionWatch({
    notifier, log,
    onRetry: () => scheduler?.beat?.() ?? Promise.resolve(),
  });
  scheduler = createScheduler({ policy, spool, producers, flusher, log, watch, notifier });

  writeDisclosureConfig(p, policy, opts, stateDir, ident);

  const oneShot = Boolean(opts.oneShot);
  let lastGate = null;
  let stopRequested = false;
  // Registered here, before the wait loop, so a stop during the gate is graceful: the loop sees
  // stopRequested on its next slice and the log says why the process is leaving.
  const stop = () => { stopRequested = true; scheduler.stop(); spool.close(); transport.close(); log('agent stopped'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Nothing is collected before enrollment completes, so an unapproved device produces no data
  // rather than data that is deleted later.
  if (opts.check) {
    // `check` is the pre-flight and troubleshooting command: it proves the socket, the pin, the
    // notice and the enrollment gate, then leaves. It does not enroll, capture, spool or schedule,
    // so running it against a device that is already working cannot disturb it.
    const report = await runCheck({ opts, p, transport, token, ident, stored, spool, scheduler, log });
    spool.close();
    transport.close();
    return report;
  }

  // From here on this process is the resident agent, so it stops taking up a window on someone's
  // desktop. Placed before the enrollment loop so a device sitting at consent_required shows no
  // window either -- that state is reported by `status`, not by a box on the screen.
  //
  // Every excluded flag is one where a person is reading this console: --verbose echoes the log,
  // --interactive prints the notice and waits for a name, and --acknowledge-by is supposed to show
  // someone the wording they are acknowledging on the device user's behalf. Hiding any of those
  // would put the disclosure somewhere nobody can see it.
  // --resident is what the scheduled task passes, and it is the only thing that suppresses the
  // console window. Someone running this command by hand keeps their window -- hiding it would take
  // over the terminal they are typing in. Placed before the enrollment loop so a device sitting at
  // consent_required shows no window either; that state is reported by `status`, not by a box on
  // the screen. The other exclusions are belt-and-braces for the same reason: --interactive prints
  // the notice and waits for a name, --verbose echoes the log, and --acknowledge-by is meant to
  // show someone the wording they are acknowledging on the device user's behalf.
  const resident = opts.resident === true
    && !opts.interactive && !opts.verbose && !opts.acknowledgeBy;
  if (resident && hideResidentConsole({ log })) {
    log('window hidden: find this agent with schtasks /query, Get-Process, or cli.js status');
  }

  while (true) {
    const enrolled = await ensureEnrolled({ p, transport, token, log, identity, ident, opts,
      stored });
    if (enrolled.justRegistered && !oneShot) notifier.show('registered');
    if (enrolled.ready) break;
    const reason = enrolled.reason;
    // The log is something the device user reads, so a reason is stated once rather than on
    // every recheck.
    if (reason !== lastGate) { log(`not collecting: ${reason}`); lastGate = reason; }
    if (oneShot || TERMINAL_STOPS.has(reason)) {
      // one-shot is a verification command: it reports the gate and leaves so a script or a
      // person can read the answer.
      transport.close();
      spool.close();
      return { status: reason };
    }
    if (stopRequested) { transport.close(); spool.close(); return { status: 'stopped' }; }
    // Waiting rather than exiting matters. The task fires at logon and on its repetition, so an
    // agent that leaves here collects nothing until the next sign-in -- which can be days after
    // the user acknowledges the notice or an admin approves the device. Nothing is captured
    // while it waits, which is what the gate is for.
    await gateSleep(GATE_RECHECK_MS);
  }

  async function refreshConfig() {
    try {
      const r = await transport.get('/api/v1/config', token.headers());
      if (r.status === 304) return policy.values;
      return policy.replace(JSON.parse(r.body.toString('utf8')), r.headers.etag ?? null);
    } catch (err) {
      log(`config fetch failed: ${err.code ?? err.message}`);
      return null;
    }
  }

  if (oneShot) {
    await refreshConfig();
    await producers.extensionTick({ force: true });
    await producers.clipboardTick();
    await producers.screenshotTick();
    const res = await flusher.cycle();
    spool.close();
    transport.close();
    return { status: 'one-shot complete', spool: spool.totals(), dropped: spool.dropped(), etag: policy.etag, res };
  }

  // A device that cannot read policy cannot know its own intervals, so it captures nothing.
  // It stays and retries: the collector being unreachable for an hour is normal, and a process
  // that exits is indistinguishable from one that was never installed.
  let values = await refreshConfig();
  while (!values) {
    await gateSleep(GATE_RECHECK_MS);
    if (stopRequested) { transport.close(); spool.close(); return { status: 'stopped' }; }
    log('policy still unreadable: waiting');
    values = await refreshConfig();
  }
  await begin(values);

  async function begin(initialValues) {
    await producers.extensionTick({ force: true }).catch(() => {});
    scheduler.start(initialValues);
    // The gate is open and this device is reporting. This is the moment a person would want stated
    // out loud if they had to learn it from a document, so it is stated on their screen instead.
    if (!oneShot) notifier.show('approved');
    await flusher.cycle().catch((err) => log(`first cycle: ${err.code ?? err.message}`));
    log(`agent running pid=${process.pid} device=${deviceId()}`);
  }

  return { status: 'running', scheduler, flusher, stop, spool, policy };
}

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

// "3h", "2d", "40m" -- the span a summary notice quotes, kept short because it goes inside a
// balloon that clips at 240 characters.
function sinceWords(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 5400) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

// How often a resident agent re-reads its gates while they are still shut. This is what picks up
// an acknowledgment typed in another window and an approval clicked in the dashboard.
const GATE_RECHECK_MS = 30000;

// Decisions about the device rather than gates waiting to open, so waiting on them would be
// pretending. token_issuance_missed needs an admin to rotate the token; declined is the device
// user's own answer.
const TERMINAL_STOPS = new Set(['declined', 'rejected', 'revoked', 'token_issuance_missed']);

function gateSleep(ms) {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

async function ensureEnrolled({ p, transport, token, log, identity, ident, opts, stored }) {
  const direct = await checkApproval({ p, transport, token, fingerprint: ident.fingerprint, log });
  if (direct.ready) return direct;
  if (direct.reason !== 'not_enrolled') return direct;

  const notice = await fetchNotice(transport);
  if (!notice) return { ready: false, reason: 'notice_unavailable' };

  const declinedFile = path.join(p.root, 'DECLINED.txt');
  // A decline recorded on this device is the device user's own answer, and it sticks: a scripted
  // acknowledgment from anywhere else cannot walk it back. Only the person typing their name into
  // this notice, in their own window, can change their mind.
  if (existsSync(declinedFile) && !opts.interactive) {
    log('declined on this device earlier: not enrolling');
    return { ready: false, reason: 'declined' };
  }

  let acknowledgedBy = opts.acknowledgeBy;
  if (!acknowledgedBy) {
    // Asked once. The resident loop comes back here on every recheck, and a second notice on the
    // same terminal reads as harassment rather than as a gate.
    if (!opts.interactive || opts.promptAsked) return { ready: false, reason: 'consent_required' };
    printNotice(notice);
    opts.promptAsked = true;
    acknowledgedBy = await prompt('Type your name to acknowledge, or "no" to decline: ');
  } else if (opts.showNotice !== false) {
    // A scripted acknowledgment is shown the wording it is acknowledging.
    printNotice(notice);
  }
  const name = String(acknowledgedBy ?? '').trim();
  if (name === '' || /^no$/i.test(name)) {
    writeFileSync(path.join(p.root, 'DECLINED.txt'),
      `Device user declined the monitoring notice at ${new Date().toISOString()}.\n`
      + 'No data has been collected from this device.\n', 'utf8');
    return { ready: false, reason: 'declined' };
  }

  try {
    const res = await transport.postJson('/api/v1/enroll', {
      fingerprint: ident.fingerprint,
      hostname: identity.hostname,
      os_build: identity.os_build,
      device_user: identity.device_user,
      agent_version: AGENT_VERSION,
      notice_version: notice.version,
      acknowledged_by: name,
      acknowledged_at: new Date().toISOString(),
    });
    // postJson hands back the raw body, like every other call here. Reading device_id off the
    // response object without parsing it left identity.json without a device id, so every later
    // run sent the placeholder in X-Device-Id and the collector rejected each screenshot.
    const body = JSON.parse(res.body.toString('utf8'));
    writeJsonFile(p.identity, {
      ...stored,
      device_id: body.device_id,
      fingerprint: ident.fingerprint,
      enrolled_at: new Date().toISOString(),
    });
    stored.device_id = body.device_id;
    log(`enrolled ${body.device_id} state=${body.state}`);
    // Reaching this line with a decline on file means the device user just typed their own name
    // into the notice, which is the only thing that can reverse their earlier answer.
    if (existsSync(declinedFile)) unlinkSync(declinedFile);
  } catch (err) {
    log(`enroll failed: ${err.code ?? err.message} ${err.detail ?? ''}`);
    return { ready: false, reason: 'enroll_failed' };
  }
  const gate = await checkApproval({ p, transport, token, fingerprint: ident.fingerprint, log });
  // `registered` is announced only on the run that actually created the row, so a device that
  // reboots every morning does not tell the user it just registered every morning.
  return { ...gate, justRegistered: true };
}

async function checkApproval({ p, transport, token, fingerprint, log }) {  try {
    const r = await transport.get(`/api/v1/enroll/status?fingerprint=${encodeURIComponent(fingerprint)}`);
    const body = JSON.parse(r.body.toString('utf8'));
    if (body.token) {
      sealToken(body.token, p.token);
      token.set(body.token);
      log('approved; token sealed into token.bin with DPAPI CurrentUser');
      return { ready: true };
    }
    if (body.state === 'approved') {
      const unsealed = openToken(p.token);
      if (unsealed) { token.set(unsealed); return { ready: true }; }
      // Token exists server-side and was already delivered once; it cannot be fetched again.
      return { ready: false, reason: 'token_issuance_missed' };
    }
    return { ready: false, reason: body.state };
  } catch (err) {
    if (err instanceof HttpError && err.code === 'unknown_device') return { ready: false, reason: 'not_enrolled' };
    // The detail carries the certificate hash actually presented, which is the difference between
    // "this collector was reinstalled" and "something else is answering on that port".
    log(`approval check failed: ${err.code ?? err.message} ${err.detail ?? ''}`.trim());
    return { ready: false, reason: 'check_failed' };
  }
}

// The pre-flight report: what the device can reach, whether the certificate matched, and where the
// consent gate stands. A transport failure is reported as a failure rather than as a healthy-
// looking report with the fields left empty, and nothing is captured or spooled on the way.
async function runCheck({ opts, p, transport, token, ident, stored, spool, scheduler, log }) {
  let notice = null;
  try {
    notice = JSON.parse((await transport.get('/api/v1/notice')).body.toString('utf8'));
  } catch (err) {
    scheduler.stop();
    const code = err instanceof HttpError ? err.code : 'internal';
    log(`check failed: ${code} ${err.detail ?? err.message}`);
    return {
      status: 'check_failed', error: code, pin_verified: transport.pinVerified(),
      detail: String(err.detail ?? err.message).slice(0, 200),
    };
  }
  const approval = await checkApproval({ p, transport, token, fingerprint: ident.fingerprint, log });
  scheduler.stop();
  return {
    status: 'check',
    collector: transport.ports().map((n) => `https://${opts.host}:${n}`).join(' or '),
    answering_on: transport.activePort(),
    pin_verified: transport.pinVerified(),
    notice_version: notice.version,
    notice_collects: notice.collects,
    enrollment: approval.ready ? 'approved' : approval.reason,
    collecting: approval.ready,
    device_id: stored.device_id ?? null,
    has_sealed_token: token.present(),
    spool: spool.totals(),
  };
}

async function fetchNotice(transport) {
  try {
    const r = await transport.get('/api/v1/notice');
    return JSON.parse(r.body.toString('utf8'));
  } catch { return null; }
}

function printNotice(notice) {
  const bar = '='.repeat(72);
  process.stdout.write(`\n${bar}\nMONITORING NOTICE (version ${notice.version})\n${bar}\n`);
  process.stdout.write(`${notice.text}\n${bar}\n`);
  process.stdout.write(`This device would collect: ${notice.collects.join(', ')}\n`);
  process.stdout.write('Declining stops all collection and records nothing.\n\n');
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveP) => rl.question(question, (a) => { rl.close(); resolveP(a); }));
}

function makeLogger(file, verbose) {
  return (message) => {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    // Anything reaching this line is visible to the device user, so it is treated as a disclosure
    // surface: no payload content, no token, no clipboard text, ever.
    const line = `${new Date().toISOString()} ${text.replace(/[A-Za-z0-9+/=]{40,}/g, '[redacted-long-token]')}\n`;
    try { appendFileSync(file, line, 'utf8'); } catch { /* logging must not break collection */ }
    if (verbose) process.stdout.write(line);
  };
}

function writeDisclosureConfig(p, policy, opts, stateDir, ident) {
  const v = policy.values;
  writeJsonFile(p.config, {
    product: 'CTTIme Endpoint Visibility',
    purpose: 'Disclosed endpoint monitoring on a company-managed Windows device.',
    agent_version: AGENT_VERSION,
    state_directory: stateDir,
    // Static disclosure only: which addresses this device was told to trust. Which one a request
    // actually landed on is a live fact and `check` reports it.
    collector: {
      host: opts.host,
      ports: (opts.ports && opts.ports.length ? opts.ports : [opts.port ?? 8443]),
      transport: 'https, pinned by certificate SHA-256 fingerprint',
    },
    collects: {
      screenshots: {
        enabled: true,
        every_minutes: v.screenshot_interval_minutes,
        skipped_when_locked: v.skip_when_locked,
        skipped_when_idle_seconds_over: v.idle_skip_seconds,
        identical_frames_uploaded: v.dedupe_unchanged_frames === false,
        server_side_retention_days: v.screenshot_retention_days,
      },
      browser_extensions: {
        enabled: v.extension_inventory_enabled,
        browsers: ['chrome', 'brave', 'edge', 'firefox'],
        how_often: `at most once per ${v.ext_inventory_max_age_hours}h, and only when a browser preference file changed`,
      },
      clipboard: {
        enabled: v.clipboard_metrics_enabled,
        every_seconds: v.clipboard_sample_seconds,
        sent: 'character count, SHA-256 of the content, kind label (text|file-list|image|empty)',
        never_sent: 'the clipboard content. It is hashed inside a child process and discarded.',
      },
      screen_state: { enabled: true, values: ['locked', 'idle', 'active'] },
    },
    // Part of the disclosure, not a footnote: the agent appears on the device user's own screen
    // when the link to the collector changes. `what-collects` prints this so the answer to "what
    // does that popup mean" is available offline, in the same command that lists the collection.
    device_user_notices: {
      shown_on_screen: true,
      when: ['the collector became unreachable', 'the collector is reachable again after a gap',
        'the collector certificate did not match the pin this device was given'],
      wording: 'factual: what changed, what it means for the data buffered on this machine, who to tell',
      history: 'the last twenty notices are recorded in <state dir>\\pending-shots\\notifications.json',
      never: 'a prompt to approve anything. The notice and its acknowledgment are separate.',
    },
    batching: {
      model: 'events append to a local spool and upload in batches; nothing is sent per event',
      heartbeat_interval_seconds: v.heartbeat_interval_seconds,
      batch_max_items: v.batch_max_items,
      batch_max_bytes: v.batch_max_bytes,
      batch_max_age_seconds: v.batch_max_age_seconds,
      spool_max_bytes: v.spool_max_bytes,
      spool_location: p.spool,
      when_full: 'oldest whole segments are deleted first and the count is reported to the server, so gaps are visible rather than silent',
    },
    policy_source: 'Every interval and threshold is set by the collector server. These are the values in effect now.',
    device_identity: { fingerprint_source: ident.source, has_smb_uuid: ident.hasSmbUuid },
    local_log: p.log,
    uninstall: 'scripts/uninstall.ps1 removes the scheduled task and deletes the state directory.',
  });
}

function createScheduler({ policy, spool, producers, flusher, log, watch, notifier }) {
  const timers = new Map();
  const startedAt = Date.now();
  function clear(name) {
    const t = timers.get(name);
    if (t) { clearInterval(t); timers.delete(name); }
  }
  function every(name, ms, fn) {
    clear(name);
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => log(`${name} tick failed: ${err.code ?? err.message}`));
    }, ms);
    // Deliberately NOT unref'd. An unref'd timer lets the event loop empty out and the process
    // exits by itself, which is how an approved, healthy agent was found dead at Last Task
    // Result 0. The timers are what keep a resident agent resident.
    timers.set(name, t);
  }
  // One heartbeat plus whatever the spool is holding. Extracted because the connection watch calls
  // it directly when the link comes back: waiting for the next scheduled tick would leave a device
  // that regained the collector at 09:01 silent until 09:05.
  let beating = false;
  async function beat() {
    if (beating) return { skipped: 'heartbeat already running' };
    beating = true;
    try {
      const res = await flusher.heartbeat();
      watch?.observe(res);
      if (res?.changed) log('heartbeat applied policy changes');
      await flusher.flushBatch();
      await flusher.flushScreenshots();
      return res;
    } finally {
      beating = false;
    }
  }

  function start(values) {
    // Derived from the live policy on every (re)start, which is what makes a dashboard edit take
    // effect within one heartbeat cycle without restarting the process.
    every('heartbeat', Math.max(30, values.heartbeat_interval_seconds) * 1000, () => beat());
    every('screenshot', Math.max(1, values.screenshot_interval_minutes) * 60000, async () => {
      const r = await producers.screenshotTick();
      if (r?.captured) await flusher.flushScreenshots();
    });
    every('clipboard', Math.max(15, values.clipboard_sample_seconds ?? 60) * 1000, () => producers.clipboardTick());
    every('extensions', 60000, () => producers.extensionTick());
    every('spool-cap', 300000, () => spool.enforceCap());
    // A standing statement that collection is happening, once an hour. The notifier throttles it to
    // roughly one notice a day, and the numbers are the flusher's own counters rather than a
    // re-derivation, so what the user is told matches what the agent sent.
    every('user-summary', 3600000, async () => {
      const c = flusher.counts();
      if (c.events + c.screenshots === 0) return;
      await notifier?.show('collecting', {
        values: {
          screenshots: c.screenshots, events: c.events, dropped: spool.dropped(),
          since: sinceWords(Date.now() - startedAt),
        },
      });
    });
  }
  function retime(values) {
    if (timers.size === 0) return;
    stop();
    start(values);
  }
  function stop() {
    for (const name of [...timers.keys()]) clear(name);
    // A retry scheduled between ticks would outlive stop() and fire a request from an agent that
    // has already closed its transport and spool.
    watch?.stop?.();
  }
  return { start, stop, retime, beat };
}

export { AGENT_VERSION };
