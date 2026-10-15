import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The device user gets told, on their own screen, when the thing watching their workstation stops
// talking to the collector, starts again, or cannot be verified.
//
// Why this is here and why it is not optional: every other guarantee in this project is a promise
// in a document. This one is the only signal the person at the keyboard gets that is produced by
// the code rather than typed by an administrator, and it is the reason the agent can run in their
// own session as a Limited user instead of hiding in a service. A monitoring agent that goes quiet
// silently is indistinguishable, from their seat, from one that was never disclosed.
//
// What it deliberately is not: a security control. A balloon cannot prove anything to the user, the
// text is authored in this file, and anyone with write access to the binary could change it. The
// trust anchor stays the pinned certificate fingerprint; this is disclosure, and it is why the
// notice text says the same thing in words.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$out = @{ shown = $false; via = 'none'; error = $null }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $icon.BalloonTipTitle = [string]$Args[0]
  $icon.BalloonTipText = [string]$Args[1]
  $icon.Visible = $true
  $icon.ShowBalloonTip([int]$Args[2])
  # A balloon is only painted while the thread pumps messages. Without this loop the call returns,
  # the icon is disposed, and the shell never draws anything -- which is exactly the silent failure
  # this module exists to prevent.
  $until = (Get-Date).AddSeconds(([int]$Args[2] / 1000) + 2)
  while ((Get-Date) -lt $until) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
  $icon.Visible = $false
  $icon.Dispose()
  $out.shown = $true
  $out.via = 'balloon'
} catch {
  $out.error = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
`;

// Windows clips the body of a balloon around 200-300 characters and the rest becomes an ellipsis,
// so the text is written to fit rather than truncated at display time.
const MAX_TITLE = 63;
const MAX_TEXT = 240;
const HISTORY = 20;

// The three things the user is told about. Wording is factual: what happened, what it means for
// their data, and what they can do. Never "press OK to continue".
export const ALERTS = {
  online: {
    title: 'CTTIme: reporting to the company collector',
    text: 'This managed device is sending its monitoring data to the company collector again. '
      + 'Nothing collected during the gap was deleted; it was buffered on this device and is '
      + 'being uploaded now.',
  },
  offline: {
    title: 'CTTIme: cannot reach the collector',
    text: 'This managed device cannot reach the company collector right now. It keeps buffering '
    + 'data locally on this machine and will upload it when the connection returns. '
    + 'Read the notice with: CTTImeAgent.exe what-collects',
  },
  unverified: {
    title: 'CTTIme: the collector could not be verified',
    text: 'Something answered the company collector address with a certificate this device was not '
      + 'told to trust. Nothing is uploaded until IT fixes it. The address and fingerprint are in '
      + 'this device\'s agent log.',
  },
  registered: {
    title: 'CTTIme: this device is registered',
    text: 'Your acknowledgment of the monitoring notice was sent to the company collector and this '
      + 'device is now registered. Nothing at all is collected until an administrator approves it. '
      + 'Read the notice again: CTTImeAgent.exe what-collects',
  },
  approved: {
    title: 'CTTIme: monitoring is now active on this device',
    text: 'An administrator approved this device. It has started sending screenshots, browser '
      + 'extension inventory and clipboard metrics on the schedule set by IT. '
      + 'What exactly, and how often: CTTImeAgent.exe what-collects',
  },
  // The standing reminder. One balloon per collection day, not one per capture: a popup every
  // minute would be dismissed unread, which teaches the user nothing, while a once-a-day summary
  // keeps the fact that collection is happening in front of them without becoming noise.
  collecting: {
    title: 'CTTIme: collection summary',
    text: 'Since this agent started {since} ago it sent {screenshots} screenshot(s) and {events} '
      + 'metric event(s) to the company collector; {dropped} dropped as the local buffer filled. '
      + 'Company-managed device. List: CTTImeAgent.exe what-collects',
  },
};

export function createNotifier({
  workDir, log = () => {}, minIntervalSeconds = 60, minSecondsByKind = null,
  historyFile = null,
} = {}) {
  mkdirSync(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'notify.ps1');
  writeFileSync(scriptPath, SCRIPT, 'utf8');
  const file = historyFile ?? path.join(workDir, 'notifications.json');
  const windows = {
    collecting: 20 * 3600,
    registered: 6 * 3600,
    approved: 6 * 3600,
    ...(minSecondsByKind ?? {}),
  };

  let state = { sent: 0, failed: 0, lastShownAt: {}, history: [] };
  try {
    if (file && path.dirname(file) === workDir) state = { ...state, ...readFileSyncSafe(file) };
  } catch { /* first run */ }
  state.lastShownAt = state.lastShownAt ?? {};

  function persist() {
    try {
      writeFileSync(file, JSON.stringify({
        ...state, lastShownAt: state.lastShownAt, history: state.history.slice(0, HISTORY),
      }));
    } catch { /* non-fatal */ }
  }

  // A notice that is already standing is not re-shouted. Three popups in a minute because the
  // network flapped would train the user to dismiss without reading, which is worse than no popup;
  // suppressed attempts are counted in history so `status` can still show that something happened.
  function shouldShow(kind) {
    const since = state.lastShownAt[kind];
    const windowSeconds = windows[kind] ?? minIntervalSeconds;
    return !(Number.isFinite(since) && Date.now() - since < windowSeconds * 1000);
  }

  function record(kind, entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, HISTORY);
    if (entry.shown) { state.sent += 1; state.lastShownAt[kind] = Date.now(); }
    else state.failed += 1;
    persist();
  }

  function show(kind, overrides = {}) {
    const alert = ALERTS[kind];
    if (!alert) return Promise.resolve({ shown: false, via: 'none', reason: `unknown alert ${kind}` });
    if (!shouldShow(kind)) {
      return Promise.resolve({ shown: false, via: 'suppressed', reason: 'already announced' });
    }
    const text = fill(String(overrides.text ?? alert.text), overrides.values ?? {});
    const title = String(overrides.title ?? alert.title).slice(0, MAX_TITLE);
    return run(title, text.slice(0, MAX_TEXT)).then((res) => {
      const entry = { kind, at: new Date().toISOString(), ...res };
      record(kind, entry);
      if (!res.shown) {
        // The popup failing is itself reported, one level down: the local log is the record that the
        // device user was not told, and `status` shows the same count.
        log(`notice '${kind}' could not be shown (${res.error ?? res.reason ?? 'unknown'}); `
          + 'recorded in the agent log instead');
      } else {
        log(`notice '${kind}' shown to the device user`);
      }
      return entry;
    });
  }

  function run(title, text, seconds = 8000) {
    return new Promise((resolveP) => {
      let child;
      try {
        child = spawn('powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
            title, text, String(seconds)],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolveP({ shown: false, via: 'none', error: err.message });
        return;
      }
      let stdout = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 25000);
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolveP({ shown: false, via: 'none', error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolveP({ shown: Boolean(parsed.shown), via: parsed.via, error: parsed.error ?? null });
        } catch {
          resolveP({ shown: false, via: 'none', error: `notify exited ${code} with no verdict` });
        }
      });
    });
  }

  return {
    show,
    scriptPath,
    // `status` and `check` read this: the device user (or whoever they call from IT) can see that
    // the agent did or did not tell them something, instead of the agent being the only witness.
    history: () => ({ sent: state.sent, failed: state.failed, last: state.history[0] ?? null,
      items: state.history.slice(0, 5) }),
  };
}

function readFileSyncSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

// {placeholder} substitution for the summary notices. An unknown key is left visibly unfilled
// rather than silently blanked, so a notice never reads as if it said something when it did not.
function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => (values[key] !== undefined ? String(values[key]) : whole));
}
