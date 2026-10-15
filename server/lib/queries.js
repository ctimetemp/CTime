// SQL shared between the JSON admin API and the server-rendered dashboard. Kept in one place so
// the two surfaces cannot disagree about what "bytes last hour" or "pending" means.
import { readPolicy } from './policy.js';

export function healthRows(db, hourAgoIso) {
  return db.prepare(`
    SELECT d.id, d.hostname, d.state, d.last_seen_at, d.spool_bytes, d.spool_dropped,
           d.bytes_sent, d.policy_etag, d.last_flush_at, d.last_flush_ms,
           (SELECT bytes_sent FROM device_traffic t WHERE t.device_id = d.id
             ORDER BY t.ts DESC LIMIT 1) AS bytes_now,
           (SELECT bytes_sent FROM device_traffic t WHERE t.device_id = d.id AND t.ts <= ?
             ORDER BY t.ts DESC LIMIT 1) AS bytes_hour_ago,
           (SELECT count(*) FROM screenshots s WHERE s.device_id = d.id) AS shots,
           (SELECT count(*) FROM screen_states ss WHERE ss.device_id = d.id) AS states
    FROM devices d ORDER BY d.hostname`).all(hourAgoIso);
}

export function overviewCounts(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const byState = one('SELECT count(*) AS c FROM devices').c;
  const shots = one('SELECT count(*) AS c, COALESCE(sum(bytes), 0) AS b FROM screenshots');
  const ext = one('SELECT count(*) AS c, count(DISTINCT device_id) AS d FROM extension_inventory');
  return {
    devices: byState,
    pending: one("SELECT count(*) AS c FROM devices WHERE state = 'pending_approval'").c,
    approved: one("SELECT count(*) AS c FROM devices WHERE state = 'approved'").c,
    revoked: one("SELECT count(*) AS c FROM devices WHERE state = 'revoked'").c,
    screenshots: shots.c,
    screenshot_bytes: shots.b,
    clipboard: one('SELECT count(*) AS c FROM clipboard_metrics').c,
    extensions: ext.c,
    ext_devices: ext.d,
  };
}

// Device labels for the paged tables. The id column of the primary row wins because only the
// hostname is pulled from devices, so a JOIN cannot shadow it.
export const SHOTS_FROM = `(SELECT s.*, d.hostname FROM screenshots s
  LEFT JOIN devices d ON d.id = s.device_id)`;
export const EXT_FROM = `(SELECT e.*, d.hostname FROM extension_inventory e
  LEFT JOIN devices d ON d.id = e.device_id)`;
export const CLIP_FROM = `(SELECT c.*, d.hostname FROM clipboard_metrics c
  LEFT JOIN devices d ON d.id = c.device_id)`;

// SQLite writes 'YYYY-MM-DD HH:MM:SS' in UTC with no marker; the agents send a real ISO string.
// Both have to become the same instant or "silent for 40 minutes" is wrong by the operator's
// timezone offset.
function toMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// The round-trip verdict for one device: what the collector has actually observed since approval,
// in the order the evidence arrives. `state` alone cannot answer "does it work" -- an approved
// device whose agent never calls in looks identical to one that is uploading every minute.
//
// This is deliberately derived, not stored: the three timestamps are written once each by the code
// that observes them, and everything else is computed here so the JSON API and the dashboard cannot
// disagree about what a device's status means.
export function verificationOf(device, { now = Date.now(), heartbeatSeconds = 300 } = {}) {
  const steps = [
    { key: 'acknowledged', label: 'Notice acknowledged on the device', at: device.acknowledged_at },
    { key: 'approved', label: 'Approved by an administrator', at: device.approved_at },
    { key: 'token', label: 'Agent collected its device token', at: device.token_delivered_at },
    { key: 'contact', label: 'Agent called in with that token', at: device.first_contact_at },
    { key: 'data', label: 'Collector accepted data from it', at: device.first_data_at },
  ];
  for (const step of steps) {
    step.done = Boolean(step.at);
    if (step.at) step.ago_ms = now - toMs(step.at);
  }

  if (device.state === 'revoked') {
    return { verdict: 'revoked', headline: 'Revoked', tone: 'bad', steps,
      detail: `Collection stopped${device.revoke_reason ? `: ${device.revoke_reason}` : ''}. `
        + 'The device row and its consent record are kept as evidence.' };
  }
  if (device.state === 'rejected') {
    return { verdict: 'rejected', headline: 'Rejected', tone: 'bad', steps,
      detail: 'An administrator rejected this device. It cannot be approved again until the device '
        + 'user acknowledges the notice afresh.' };
  }
  if (device.state === 'pending_approval') {
    return { verdict: 'awaiting_approval', headline: 'Waiting for you', tone: 'warn', steps,
      detail: 'The device user has agreed. Nothing is collected until this is approved.' };
  }

  const missing = steps.find((s) => !s.done && s.key !== 'acknowledged' && s.key !== 'approved');
  if (missing?.key === 'token') {
    return { verdict: 'token_pending', headline: 'Approved, agent has not called in', tone: 'warn',
      steps, detail: 'The token is waiting. The agent fetches it on its next check -- within about '
        + 'five minutes of the approval, sooner if the task has just run.' };
  }
  if (missing?.key === 'contact') {
    return { verdict: 'no_contact', headline: 'Token issued, no request yet', tone: 'warn', steps,
      detail: 'The agent has its token but has not made an authenticated request. Check the device '
        + 'is on, that it can reach this collector, and that the scheduled task is running.' };
  }
  if (missing?.key === 'data') {
    return { verdict: 'no_data', headline: 'Talking, but no data accepted yet', tone: 'warn', steps,
      detail: 'The agent is authenticated and reporting. The first batch is usually within one '
        + 'capture interval; if this persists, look at the spool depth on Telemetry health.' };
  }

  const lastSeen = toMs(device.last_seen_at);
  const silenceSeconds = lastSeen === null ? null : (now - lastSeen) / 1000;
  const allowed = Math.max(120, heartbeatSeconds * 3);
  if (silenceSeconds !== null && silenceSeconds > allowed) {
    return { verdict: 'silent', headline: `Silent for ${humanGap(silenceSeconds)}`, tone: 'bad',
      steps, detail: `Last heard from ${humanGap(silenceSeconds)} ago, against a heartbeat every `
        + `${Math.round(heartbeatSeconds / 60)} min. The agent has stopped, the device is off, or it `
        + 'cannot reach this collector.' };
  }
  return { verdict: 'working', headline: 'Confirmed working', tone: 'good', steps,
    detail: `Reporting every heartbeat, data accepted since ${absLabel(device.first_data_at)}.` };
}

// The device columns both admin surfaces read. Listed once, here, so a new stamp cannot turn up in
// the JSON API and be quietly missing from the dashboard -- or the reverse.
export const DEVICE_COLS = `id, hostname, os_build, device_user, lan_ip, agent_version, state,
  enrolled_at, last_seen_at, notice_version, acknowledged_at, acknowledged_by,
  approved_by, approved_at, revoked_by, revoked_at, revoke_reason, policy_etag,
  spool_dropped, spool_bytes, bytes_sent, last_flush_at, last_flush_ms,
  token_delivered_at, first_contact_at, first_data_at`;

// Binds the verdict to this collector's own heartbeat interval, so "silent" means missed beats at
// the rate the operator set rather than a constant baked into the page.
export function makeVerifier(db) {
  const seconds = Number(readPolicy(db).heartbeat_interval_seconds) || 300;
  return (device) => verificationOf(device, { now: Date.now(), heartbeatSeconds: seconds });
}

export function humanGap(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function absLabel(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

