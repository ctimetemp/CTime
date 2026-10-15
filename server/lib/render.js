// Server-side rendering for the dashboard. Every view is a pure function of a row set, and the
// same function backs both the full page and the polled fragment, so there is one render path.
// Nothing here escapes markup by accident: every value derived from the database goes through esc().

const NAV = [
  { path: '/', label: 'Overview', region: 'overview' },
  { path: '/screenshots', label: 'Screenshots', region: 'shots' },
  { path: '/extensions', label: 'Extensions', region: 'extensions' },
  { path: '/clipboard', label: 'Clipboard', region: 'clipboard' },
  { path: '/health', label: 'Telemetry health', region: 'health' },
  { path: '/audit', label: 'Audit log', region: 'audit' },
  { path: '/policy', label: 'Policy', region: 'policy' },
  { path: '/help', label: 'Help', region: 'help' },
];

export function esc(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' with no marker and is UTC; the agent
// sends 'YYYY-MM-DDTHH:MM:SS.sssZ'. Both must render as the same instant, and the consent
// comparison in admin.js depends on that normalization having happened at write time.
function toDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n) { return String(n).padStart(2, '0'); }

export function absTime(value) {
  const d = toDate(value);
  if (!d) return { text: '—', iso: null };
  const iso = d.toISOString();
  return { text: `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`, iso };
}

export function since(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return 'never';
  const secs = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KiB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MiB`;
  return `${(v / 1073741824).toFixed(2)} GiB`;
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

// Policy keys are stored in their natural unit (bytes, seconds) because that is what the agent
// compares against, but an operator thinks in MiB and minutes. The raw number stays in the input;
// this is a read-only gloss under it.
const DURATION_OF = { _seconds: 1, _minutes: 60, _hours: 3600, _days: 86400 };

export function humanize(key, value) {
  if (value === null || value === undefined || value === '') return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (key.endsWith('_bytes')) return fmtBytes(v);
  for (const [suffix, mult] of Object.entries(DURATION_OF)) {
    if (!key.endsWith(suffix)) continue;
    const secs = v * mult;
    if (secs >= 86400 && secs % 86400 === 0) return `${fmtNum(secs / 86400)} d`;
    if (secs >= 3600 && secs % 3600 === 0) return `${fmtNum(secs / 3600)} h`;
    if (secs >= 60 && secs % 60 === 0) return `${fmtNum(secs / 60)} min`;
    return `${fmtNum(secs)} s`;
  }
  return null;
}

const STATE_LABEL = {
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
};

function badge(state) {
  const known = Object.hasOwn(STATE_LABEL, state) ? state : 'rejected';
  return `<span class="badge b-${known}">${esc(STATE_LABEL[state] ?? state)}</span>`;
}

// The chip is the round-trip verdict, not the state badge: a badge says what an administrator
// decided, a chip says what the collector has observed since. They are shown next to each other
// precisely because the difference is the thing an operator needs to notice.
const CHIP_TONE = { good: 'ok', warn: 'warn', bad: 'bad' };

export function statusChip(verification) {
  if (!verification) return '<span class="muted">no status</span>';
  const tone = CHIP_TONE[verification.tone] ?? 'warn';
  return `<span class="chip chip-${tone}" title="${esc(verification.detail)}">${esc(verification.headline)}</span>`;
}

function timeCell(value, now) {
  const t = absTime(value);
  if (!t.iso) return '<td class="muted">—</td>';
  return `<td>${timeEl(value)}${relEl(value, now)}</td>`;
}

// Times are rendered from the instant, in UTC, with the ISO value carried in `datetime`. The
// text is therefore correct on a page read without JavaScript or fetched with curl, and app.js
// rewrites it into the operator's own zone using the same instant rather than a parsed guess.
function timeEl(value, cls = 't') {
  const d = toDate(value);
  if (!d) return `<span class="${cls} muted">—</span>`;
  return `<time class="${cls}" datetime="${esc(d.toISOString())}">${esc(absTime(value).text)}</time>`;
}

function relEl(value, now) {
  const d = toDate(value);
  if (!d) return '';
  return `<span class="rel" data-at="${esc(d.toISOString())}">${esc(since(value, now))}</span>`;
}

function emptyRow(colspan, message) {
  return `<tr class="empty"><td colspan="${colspan}">${esc(message)}</td></tr>`;
}

export function layout({ title, path, body, csrf = null, account = null, pending = 0, noticeVersion = null, error = null }) {
  const nav = NAV.map((item) => {
    const active = item.path === path ? ' active' : '';
    const count = item.path === '/' && pending > 0 ? `<span class="navcount">${esc(pending)}</span>` : '';
    return `<a class="navitem${active}" href="${esc(item.path)}">${esc(item.label)}${count}</a>`;
  }).join('');
  const session = account
    ? `<div class="session"><span class="who">${esc(account)}</span>`
      + `<button class="linklike" data-action="logout" type="button">Sign out</button></div>`
    : '';
  const banner = error ? `<div class="banner error">${esc(error)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${esc(csrf ?? '')}">
<title>${esc(title)} · CTTIme</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="mark">Z</span><span>CTTIme</span><span class="sub">endpoint visibility</span></div>
  ${session}
</header>
<nav class="tabs">${nav}</nav>
${banner}
<main>
${body}
</main>
<footer class="foot">
  <p><strong>Disclosed monitoring.</strong> Agents run as a named Task Scheduler job
    &ldquo;CTTIme Endpoint Visibility&rdquo;, write a local log, and can be uninstalled with
    uninstall.ps1. Clipboard content is never collected: only a character count, a SHA-256 and a
    kind label. Screenshots are never analysed by OCR or image recognition.
    ${noticeVersion ? `Notice version in force: <code>${esc(noticeVersion)}</code>.` : ''}</p>
</footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

export function pagePending({ items, now, poll }) {
  const rows = items.map((d) => `
  <tr>
    <td><a class="host" href="/devices/${esc(d.id)}">${esc(d.hostname)}</a>
      <span class="sub">${esc(d.device_user)} · ${esc(d.os_build)}</span></td>
    <td>${esc(d.lan_ip ?? '—')}</td>
    <td>${esc(d.agent_version)}</td>
    ${timeCell(d.enrolled_at, now)}
    <td>${d.acknowledged_by ? `<strong>${esc(d.acknowledged_by)}</strong><span class="sub">${timeEl(d.acknowledged_at)}</span>` : '<span class="bad">no acknowledgment</span>'}</td>
    <td>${esc(d.notice_version ?? '—')}</td>
    <td>${statusChip(d.verification)}</td>
    <td class="actions">
      <button type="button" class="btn primary" data-action="approve" data-id="${esc(d.id)}" data-name="${esc(d.hostname)}">Approve</button>
      <button type="button" class="btn" data-action="reject" data-id="${esc(d.id)}" data-name="${esc(d.hostname)}">Reject</button>
    </td>
  </tr>`).join('');
  return `<section class="region" data-region="pending"${pollAttr(poll)}>
  <div class="regionhead"><h2>Approval queue</h2>
    <p class="hint">Nothing is collected from a device until it appears here with a recorded
      acknowledgment and is approved. Approve is refused by the database itself if the
      acknowledgment is missing, blank, or older than the current notice version.</p></div>
  <table>
    <thead><tr><th>Device</th><th>LAN IP</th><th>Agent</th><th>Enrolled</th>
      <th>Acknowledged by</th><th>Notice</th><th>What happens next</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(8, 'No devices waiting for approval.')}</tbody>
  </table>
</section>`;
}

export function pageDevices({ items, now, poll }) {
  const rows = items.map((d) => `
  <tr>
    <td><a class="host" href="/devices/${esc(d.id)}">${esc(d.hostname)}</a>
      <span class="sub">${esc(d.device_user)}</span></td>
    <td>${badge(d.state)}<span class="sub">${statusChip(d.verification)}</span></td>
    ${timeCell(d.last_seen_at, now)}
    <td>${esc(d.acknowledged_by ?? '—')}</td>
    <td class="num">${fmtBytes(d.spool_bytes)}</td>
    <td class="num${d.spool_dropped > 0 ? ' warn' : ''}">${fmtNum(d.spool_dropped)}</td>
    <td class="num">${fmtBytes(d.bytes_sent)}</td>
  </tr>`).join('');
  return `<section class="region" data-region="devices"${pollAttr(poll)}>
  <div class="regionhead"><h2>Devices</h2>
    <p class="hint">Device fingerprints and tokens are never sent to this page. Click a hostname
      for detail, export and the consent history.</p></div>
  <table>
    <thead><tr><th>Device</th><th>State</th><th>Last seen</th><th>Consent</th>
      <th class="num">Spool</th><th class="num">Dropped</th><th class="num">Sent</th></tr></thead>
    <tbody>${rows || emptyRow(7, 'No devices have enrolled yet.')}</tbody>
  </table>
</section>`;
}

export function pageCounts({ counts, tally, etag }) {
  const card = (label, value, note) => `<div class="card"><span class="k">${esc(label)}</span>
    <span class="v">${esc(value)}</span><span class="n">${esc(note ?? '')}</span></div>`;
  const seen = tally ? `${fmtNum(tally.working)} confirmed working`
    : `${fmtNum(counts.approved)} approved`;
  return `<section class="cards">
  ${card('Devices', fmtNum(counts.devices), `${fmtNum(counts.pending)} pending · ${seen}`)}
  ${tally ? card('Collection actually reaching this collector',
    `${fmtNum(tally.working)}/${fmtNum(counts.devices)}`,
    `${fmtNum(tally.waiting)} waiting on a step · ${fmtNum(tally.stopped)} stopped or refused`) : ''}
  ${card('Screenshots', fmtNum(counts.screenshots), `${fmtBytes(counts.screenshot_bytes)} on disk`)}
  ${card('Clipboard samples', fmtNum(counts.clipboard), 'counts and hashes only')}
  ${card('Extension rows', fmtNum(counts.extensions), `${fmtNum(counts.ext_devices)} devices inventoried`)}
  ${card('Policy etag', etag.replace(/"/g, ''), 'changes reach agents on next heartbeat')}
</section>`;
}

export function pageDetail({ device, counts, verification, policyStale, currentEtag, now, shots, extensions, clipboard }) {
  const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
  const consent = device.state === 'revoked' || device.revoked_at
    ? `<div class="consent revoked">
        ${row('Acknowledged by', esc(device.acknowledged_by ?? '—'))}
        ${row('Acknowledged at', timeEl(device.acknowledged_at))}
        ${row('Notice version', esc(device.notice_version ?? '—'))}
        ${row('Approved by', esc(device.approved_by ?? '—'))}
        ${row('Approved at', timeEl(device.approved_at))}
        ${row('Revoked by', esc(device.revoked_by ?? '—'))}
        ${row('Revoked at', timeEl(device.revoked_at))}
        ${row('Reason', esc(device.revoke_reason ?? '—'))}
        <p class="hint">Re-enabling a revoked device does not carry consent over: approval is
          refused until the device user acknowledges the notice again.</p>
      </div>`
    : `<div class="consent">
        ${row('Acknowledged by', esc(device.acknowledged_by ?? '—'))}
        ${row('Acknowledged at', timeEl(device.acknowledged_at))}
        ${row('Notice version', esc(device.notice_version ?? '—'))}
        ${row('Approved by', esc(device.approved_by ?? '—'))}
        ${row('Approved at', timeEl(device.approved_at))}
      </div>`;
  const actions = `<div class="actions">
    ${device.state === 'pending_approval' || device.state === 'rejected'
      ? `<button type="button" class="btn primary" data-action="approve" data-id="${esc(device.id)}" data-name="${esc(device.hostname)}">Approve</button>` : ''}
    ${device.state === 'pending_approval'
      ? `<button type="button" class="btn" data-action="reject" data-id="${esc(device.id)}" data-name="${esc(device.hostname)}">Reject</button>` : ''}
    ${device.state === 'approved'
      ? `<button type="button" class="btn danger" data-action="revoke" data-id="${esc(device.id)}" data-name="${esc(device.hostname)}">Revoke</button>` : ''}
    <a class="btn" href="/devices/${esc(device.id)}?verify=1">Confirm this device</a>
    ${device.state === 'revoked'
      ? `<button type="button" class="btn" data-action="reenable" data-id="${esc(device.id)}" data-name="${esc(device.hostname)}">Re-enable (needs re-acknowledgment)</button>` : ''}
    <button type="button" class="btn" data-action="export" data-id="${esc(device.id)}" data-name="${esc(device.hostname)}">Export all data (JSON)</button>
  </div>`;
  const shotCells = shots.map((s) => `<a class="thumb" href="/media/screenshots/${esc(s.id)}" target="_blank" rel="noopener">
      <img loading="lazy" src="/media/screenshots/${esc(s.id)}" alt="screenshot ${esc(s.event_id)}">
      <span>${timeEl(s.captured_at)} · ${esc(s.width)}×${esc(s.height)}</span></a>`).join('');
  const extRows = extensions.map((e) => `<tr>
      <td>${esc(e.browser)}<span class="sub">${esc(e.profile)}</span></td>
      <td>${esc(e.name ?? '—')}<span class="sub mono">${esc(e.ext_id)}</span></td>
      <td>${esc(e.version ?? '—')}</td><td>${esc(e.source ?? '—')}</td>
      <td>${e.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill">disabled</span>'}</td>
      <td class="num">${parseArray(e.permissions).length}</td></tr>`).join('');
  const clipRows = clipboard.map((c) => `<tr>
      ${timeCell(c.sampled_at, now)}
      <td class="num">${fmtNum(c.char_count)}</td><td>${esc(c.content_kind ?? '—')}</td>
      <td class="mono">${esc(String(c.sha256).slice(0, 16))}</td></tr>`).join('');
  const verificationPanel = verification ? `<h3>Round trip</h3>
      <div class="verify">
        <p class="verdict v-${esc(CHIP_TONE[verification.tone] ?? 'warn')}">
          <strong>${esc(verification.headline)}</strong>
          <span class="sub">${esc(verification.detail)}</span></p>
        <ol class="steps">
          ${verification.steps.map((s) => `<li class="${s.done ? 'done' : 'todo'}">
            <span class="tick">${s.done ? '&#10003;' : '&middot;'}</span>
            <div><strong>${esc(s.label)}</strong>
              <span class="sub">${s.done ? timeEl(s.at) : '<span class="muted">has not happened</span>'}</span></div>
          </li>`).join('')}
        </ol>
      </div>` : '';
  return `<section class="region">
  <div class="regionhead"><h2><a href="/" class="crumb">Devices</a> / ${esc(device.hostname)}</h2>
    <div class="stateline">${badge(device.state)}${verification ? ' ' + statusChip(verification) : ''}
      <span class="dot"></span>last seen ${relEl(device.last_seen_at, now)}
      <span class="dot"></span>${esc(device.lan_ip ?? 'no ip reported')}
      <span class="dot"></span>agent ${esc(device.agent_version)}
      ${policyStale ? '<span class="pill stale">policy stale</span>' : '<span class="pill ok">policy current</span>'}
      ${device.spool_dropped > 0 ? `<span class="pill warn">${fmtNum(device.spool_dropped)} dropped</span>` : ''}
    </div>${actions}</div>
  <div class="twocol">
    <div>
      <h3>Identity</h3>
      <div class="kvlist">
        ${row('Device id', `<span class="mono">${esc(device.id)}</span>`)}
        ${row('Device user', esc(device.device_user))}
        ${row('OS build', esc(device.os_build))}
        ${row('Enrolled', timeEl(device.enrolled_at))}
        ${row('Policy etag', `<span class="mono">${esc(device.policy_etag ?? 'none')}</span>`)}
        ${row('Current etag', `<span class="mono">${esc(currentEtag)}</span>`)}
        ${row('Spool', `${fmtBytes(device.spool_bytes)} · ${fmtNum(device.spool_dropped)} dropped`)}
        ${row('Last flush', `${timeEl(device.last_flush_at)} · ${fmtNum(device.last_flush_ms)} ms`)}
      </div>
      <h3>Consent record</h3>${consent}
      ${verificationPanel}
      <h3>Volumes</h3>
      <div class="kvlist">
        ${row('Screenshots', fmtNum(counts.screenshots))}
        ${row('Screen states', fmtNum(counts.screen_states))}
        ${row('Clipboard samples', fmtNum(counts.clipboard_samples))}
        ${row('Extension rows', `${fmtNum(counts.extension_rows)} · last ${relEl(counts.last_inventory, now)}`)}
      </div>
    </div>
    <div>
      <h3>Recent screenshots <span class="sub">${fmtNum(counts.screenshots)} total</span></h3>
      <div class="thumbs">${shotCells || '<p class="muted">None captured yet.</p>'}</div>
      <h3>Recent clipboard metrics</h3>
      <table class="compact"><thead><tr><th>Sampled</th><th class="num">Chars</th><th>Kind</th><th>SHA-256 (truncated)</th></tr></thead>
        <tbody>${clipRows || emptyRow(4, 'No samples yet.')}</tbody></table>
      <h3>Extension inventory</h3>
      <table class="compact"><thead><tr><th>Browser</th><th>Extension</th><th>Version</th><th>Source</th><th class="num">State</th><th class="num">Perms</th></tr></thead>
        <tbody>${extRows || emptyRow(6, 'No inventory submitted yet.')}</tbody></table>
    </div>
  </div>
</section>`;
}

export function pageShots({ items, next, hasMore, hrefBase, poll, deviceOptions = [] }) {
  const cells = items.map((s) => `<figure class="shot">
    <a href="/media/screenshots/${esc(s.id)}" target="_blank" rel="noopener">
      <img loading="lazy" src="/media/screenshots/${esc(s.id)}" alt="Screenshot ${esc(s.event_id)}"></a>
    <figcaption><a class="host" href="/devices/${esc(s.device_id)}">${esc(s.hostname ?? s.device_id)}</a>
      ${timeEl(s.captured_at)}
      <span class="sub">${esc(s.width)}×${esc(s.height)} · ${fmtBytes(s.bytes)}${s.phash ? ` · phash ${esc(String(s.phash).slice(0, 8))}` : ''}</span>
      <span class="sub">expires ${timeEl(s.expires_at)}</span></figcaption>
  </figure>`).join('');
  return `<section class="region" data-region="shots"${pollAttr(poll)}>
  <div class="regionhead"><h2>Screenshot wall</h2>
    <p class="hint">Oldest images are deleted by the retention sweeper once past
      <code>expires_at</code>; the wall shows that date so a missing file is not a mystery.
      Pixels are never analysed on the server.</p>
    ${filterForm([deviceField(deviceOptions)], hrefBase)}</div>
  <div class="wall">${cells || '<p class="muted">No screenshots retained for this filter.</p>'}</div>
  ${pager({ next, hasMore, hrefBase })}
</section>`;
}

export function pageExtensions({ items, next, hasMore, hrefBase, poll, deviceOptions = [], browserOptions = [] }) {
  const rows = items.map((e) => {
    const perms = parseArray(e.permissions);
    return `<tr>
    <td>${timeEl(e.collected_at)}</td>
    <td><a class="host" href="/devices/${esc(e.device_id)}">${esc(e.hostname ?? e.device_id)}</a></td>
    <td>${esc(e.browser)}<span class="sub">${esc(e.profile)}</span></td>
    <td>${esc(e.name ?? '—')}<span class="sub mono">${esc(e.ext_id)}</span></td>
    <td>${esc(e.version ?? '—')}</td>
    <td>${esc(e.source ?? '—')}</td>
    <td>${e.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill">disabled</span>'}</td>
    <td>${perms.length ? `<details><summary>${perms.length}</summary><ul class="perms">${perms.map((p) => `<li class="mono">${esc(p)}</li>`).join('')}</ul></details>` : '<span class="muted">none</span>'}</td>
  </tr>`;
  }).join('');
  return `<section class="region" data-region="extensions"${pollAttr(poll)}>
  <div class="regionhead"><h2>Browser extension inventory</h2>
    <p class="hint">An agent re-reads its profiles at most once per
      <code>ext_inventory_max_age_hours</code>, so this table is a snapshot of a profile, not a
      live feed. Nothing here changes what a browser does.</p>
    ${filterForm([deviceField(deviceOptions),
      { name: 'browser', label: 'Browser', allLabel: 'All browsers', options: browserOptions }], hrefBase)}</div>
  <table>
    <thead><tr><th>Collected</th><th>Device</th><th>Browser</th><th>Extension</th><th>Version</th>
      <th>Source</th><th>State</th><th>Permissions</th></tr></thead>
    <tbody>${rows || emptyRow(8, 'No extension inventory collected yet.')}</tbody>
  </table>
  ${pager({ next, hasMore, hrefBase })}
</section>`;
}

export function pageClipboard({ items, histogram, next, hasMore, hrefBase, now, poll, deviceOptions = [] }) {
  const hist = histogram.map((h) => `<tr><td>${esc(h.content_kind ?? '—')}</td>
    <td class="num">${fmtNum(h.n)}</td><td class="num">${fmtNum(Math.round(h.avg_chars ?? 0))}</td>
    <td class="num">${fmtNum(h.min_chars)}</td><td class="num">${fmtNum(h.max_chars)}</td></tr>`).join('');
  const rows = items.map((c) => `<tr>
    ${timeCell(c.sampled_at, now)}
    <td><a class="host" href="/devices/${esc(c.device_id)}">${esc(c.hostname ?? c.device_id)}</a></td>
    <td class="num">${fmtNum(c.char_count)}</td>
    <td>${esc(c.content_kind ?? '—')}</td>
    <td class="mono">${esc(String(c.sha256).slice(0, 24))}</td>
  </tr>`).join('');
  return `<section class="region" data-region="clipboard"${pollAttr(poll)}>
  <div class="regionhead"><h2>Clipboard metrics</h2>
    <div class="noticebox"><strong>No content exists to be shown here.</strong> The agent hashes
      the clipboard in memory and transmits only the character count, the digest and a coarse kind
      label. There is no column, log line or spool record in the product capable of holding
      clipboard text, and requests that try to send one are rejected with <code>422</code>.</div>
    ${filterForm([deviceField(deviceOptions)], hrefBase)}</div>
  <table class="compact hist"><thead><tr><th>Kind</th><th class="num">Samples</th>
    <th class="num">Mean chars</th><th class="num">Min</th><th class="num">Max</th></tr></thead>
    <tbody>${hist || emptyRow(5, 'No samples yet.')}</tbody></table>
  <h3>Recent samples</h3>
  <table><thead><tr><th>Sampled</th><th>Device</th><th class="num">Chars</th><th>Kind</th>
    <th>SHA-256 (truncated)</th></tr></thead>
    <tbody>${rows || emptyRow(5, 'No samples retained for this filter.')}</tbody></table>
  ${pager({ next, hasMore, hrefBase })}
</section>`;
}

export function pageAudit({ items, next, hasMore, hrefBase, now, poll }) {
  const rows = items.map((a) => `<tr>
    ${timeCell(a.ts, now)}
    <td>${shortActor(a.actor)}</td>
    <td><span class="action">${esc(a.action)}</span></td>
    <td>${esc(a.target ?? '—')}</td>
    <td class="detail">${esc(a.detail ?? '')}</td>
    <td class="mono">${esc(a.ip ?? '—')}</td>
  </tr>`).join('');
  return `<section class="region" data-region="audit"${pollAttr(poll)}>
  <div class="regionhead"><h2>Audit log</h2>
    <p class="hint">Append-only record of consent decisions, approvals, revocations, policy writes,
      exports and every screenshot view. Detail cells carry ids, key names and counts &mdash; never
      request bodies, tokens or clipboard text.</p>
    ${filterForm([], hrefBase)}</div>
  <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
    <tbody>${rows || emptyRow(6, 'Nothing has been audited yet.')}</tbody></table>
  ${pager({ next, hasMore, hrefBase })}
</section>`;
}

export function pageHealth({ devices, currentEtag, now, poll }) {
  const rows = devices.map((d) => `<tr>
    <td><a class="host" href="/devices/${esc(d.id)}">${esc(d.hostname)}</a></td>
    <td>${badge(d.state)}</td>
    ${timeCell(d.last_seen_at, now)}
    <td class="num${d.bytes_last_hour > 0 ? '' : ' muted'}">${fmtBytes(d.bytes_last_hour)}</td>
    <td class="num">${fmtBytes(d.spool_bytes)}</td>
    <td class="num${d.spool_dropped > 0 ? ' warn' : ''}">${fmtNum(d.spool_dropped)}</td>
    <td class="num">${fmtNum(d.last_flush_ms)}</td>
    <td class="num">${fmtNum(d.screenshots)}</td>
    <td class="num">${fmtNum(d.screen_states)}</td>
    <td>${!d.policy_etag ? '<span class="pill">never reported</span>'
      : d.policy_stale ? '<span class="pill stale">behind</span>' : '<span class="pill ok">current</span>'}</td>
    <td>${d.spool_dropped > 0 ? '<span class="pill warn">gaps</span>' : '<span class="pill ok">clean</span>'}</td>
  </tr>`).join('');
  return `<section class="region" data-region="health"${pollAttr(poll)}>
  <div class="regionhead"><h2>Telemetry health</h2>
    <p class="hint">Per device: how much it sent in the last hour, whether its spool is growing,
      how many events it dropped after the spool cap was hit, and whether it is still running an
      older policy than <code>${esc(currentEtag)}</code>. A nonzero drop count means the collector
      was unreachable long enough for the spool to evict.</p></div>
  <table><thead><tr><th>Device</th><th>State</th><th>Last seen</th><th class="num">Bytes / h</th>
    <th class="num">Spool</th><th class="num">Dropped</th><th class="num">Flush ms</th>
    <th class="num">Shots</th><th class="num">States</th><th>Policy</th><th>Gaps</th></tr></thead>
    <tbody>${rows || emptyRow(11, 'No devices have enrolled yet.')}</tbody></table>
</section>`;
}

export function pagePolicy({ policy, meta, writable, bounds, noticeVersion, noticeText, etag, updated }) {
  const byKey = new Map(meta.map((m) => [m.key, m]));
  const fields = writable.map((key) => {
    const value = policy[key];
    const m = byKey.get(key);
    const bool = typeof value === 'boolean';
    const [lo, hi] = bounds[key] ?? [];
    const control = bool
      ? `<select name="${esc(key)}" data-kind="bool">
          <option value="true"${value === true ? ' selected' : ''}>true</option>
          <option value="false"${value === false ? ' selected' : ''}>false</option></select>`
      : `<input type="number" name="${esc(key)}" data-kind="int" value="${esc(value)}"
          ${lo !== undefined ? `min="${esc(lo)}" max="${esc(hi)}"` : ''} step="1">
          ${humanize(key, value) ? `<span class="unit" data-unit-for="${esc(key)}">${esc(humanize(key, value))}</span>` : ''}`;
    return `<tr>
      <td><code>${esc(key)}</code><span class="sub">${esc(KEY_NOTES[key] ?? '')}</span></td>
      <td class="cellv">${control}</td>
      <td class="num">${lo !== undefined
        ? `${esc(lo)}–${esc(hi)}${humanize(key, lo) ? `<span class="sub">${esc(humanize(key, lo))} – ${esc(humanize(key, hi))}</span>` : ''}`
        : '<span class="muted">—</span>'}</td>
      <td>${m ? `${timeEl(m.updated_at)}<span class="sub">${esc(m.updated_by)}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  return `<section class="region" data-region="policy">
  <div class="regionhead"><h2>Collection policy</h2>
    <p class="hint">Agents learn these values on their next heartbeat; nothing on the device needs
      restarting. Only keys that actually changed are sent, so an edit costs one small delta per
      device rather than a config download. Current etag <code>${esc(etag)}</code>.</p></div>
  <form class="policyform" data-action="policy">
    <table><thead><tr><th>Key</th><th>Value</th><th class="num">Allowed</th><th>Last set</th></tr></thead>
      <tbody>${fields}</tbody></table>
    <p class="formnote" data-role="policy-note">${esc(updated ?? 'Edit a value and save. Values outside the allowed range are refused before anything is written.')}</p>
    <button type="submit" class="btn primary">Save changed keys</button>
  </form>
  <h3>Notice text</h3>
  <p class="hint">Bumping the notice version replaces the text every agent must show and returns
    every approved device to the approval queue. Consent is never inherited across a bump -- that
    is the point of it.</p>
  <form class="noticeform" data-action="notice">
    <label>Version <input type="text" name="version" value="${esc(noticeVersion)}" placeholder="YYYY-MM-DD.n" required></label>
    <label>Text shown to the device user <textarea name="text" rows="8" required>${esc(noticeText)}</textarea></label>
    <p class="formnote" data-role="notice-note">Saving the same version with new wording does not
      reset consent; change the version string to force everyone to acknowledge again.</p>
    <button type="submit" class="btn danger">Set notice text</button>
  </form>
</section>`;
}

// A collector with no account has nothing to sign in with -- by design, since a shipped default
// credential is a credential nobody rotates. This form is the way through that wall, and the
// first-run code in it is what proves the person filling it in can read the collector's own disk.
export function pageClaim({ error }) {
  return `<section class="loginpane">
  <h1>Create the first administrator</h1>
  <p class="hint">This collector has no administrator account and no default password. Creating the
    first one needs the <strong>first-run code</strong> printed on this collector's console at boot
    and kept in <code>first-run-code.txt</code> inside its data directory. Reading that code means
    having access to the machine the collector runs on, which is the one thing a remote request
    cannot prove.</p>
  ${error ? `<div class="banner error">${esc(error)}</div>` : ''}
  <form data-action="claim" autocomplete="off">
    <label>Account <input type="text" name="account" required minlength="3" maxlength="32"
      pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
      title="Letters, digits, dot, dash or underscore; 3 to 32 characters."></label>
    <label>Password <input type="password" name="password" required minlength="12" maxlength="512"
      autocomplete="new-password"></label>
    <label>Confirm password <input type="password" name="confirm" required maxlength="512"
      autocomplete="new-password"></label>
    <label>First-run code <input type="text" name="code" required maxlength="23"
      placeholder="XXXXX-XXXXX-XXXXX" autocapitalize="characters" spellcheck="false"></label>
    <button type="submit" class="btn primary">Create account and sign in</button>
  </form>
  <p class="hint">At least 12 characters for the password. Dashes and spaces in the code are
    ignored and case does not matter. As soon as an account exists the code is deleted and this
    form closes itself; later accounts come from a console on the collector with
    <code>node scripts/make-account.js &lt;name&gt;</code>.</p>
  <noscript><div class="banner">This form needs JavaScript to submit. The console does the same
    thing without it: <code>node scripts/make-account.js &lt;name&gt;</code>.</div></noscript>
</section>`;
}

// The path a device walks through, in the order the collector actually observes each step. It is
// here because the old Overview answered "0 pending, 0 approved" and left a new operator to guess
// what to do next. It stops rendering once a device is confirmed working.
export function pageChecklist({ counts, acknowledged, working }) {
  const steps = [
    { done: counts.devices > 0, label: 'An agent is installed and has enrolled',
      doneNote: `${fmtNum(counts.devices)} device(s) have enrolled`,
      todo: 'On the device, as the device user: run install.ps1 with the collector host and the '
        + 'certificate fingerprint printed at boot. It registers a named, visible scheduled task '
        + 'under that user, writes a disclosure note beside it, and asks for nothing as '
        + 'administrator.' },
    { done: acknowledged > 0, label: 'The device user acknowledged the notice in their own window',
      doneNote: `${fmtNum(acknowledged)} acknowledgment(s) on record`,
      todo: 'Nothing is captured before this step, and it cannot be typed for them: an agent run '
        + 'with a scripted name from a deployment script is refused, and the database refuses an '
        + 'approval whose acknowledgment is missing or blank.' },
    { done: counts.approved > 0, label: 'An administrator approved the device',
      doneNote: `${fmtNum(counts.approved)} approved, ${fmtNum(counts.pending)} waiting on you`,
      todo: 'Use Approve in the queue below. The agent notices by itself on its next check -- '
        + 'about five minutes -- without a restart or a re-login.' },
    { done: working > 0, label: 'The round trip is confirmed: token, call home, data accepted',
      doneNote: `${fmtNum(working)} device(s) confirmed reporting`,
      todo: 'Open a device and use "Confirm this device". It lists the five stamps in order, so an '
        + 'approved device whose agent never calls in says so instead of looking fine.' },
  ];
  const items = steps.map((s, i) => `<li class="${s.done ? 'done' : 'todo'}">
      <span class="tick">${s.done ? '&#10003;' : esc(i + 1)}</span>
      <div><strong>${esc(s.label)}</strong>
        <span class="sub">${esc(s.done ? s.doneNote : s.todo)}</span></div>
    </li>`).join('');
  return `<section class="region checklist" data-region="checklist">
  <div class="regionhead"><h2>Getting a device collecting</h2>
    <p class="hint">Four things have to happen in this order. This list goes away when the last one
      has happened for at least one device.</p></div>
  <ol class="steps">${items}</ol>
</section>`;
}

export function pageLogin({ error }) {
  return `<section class="loginpane">
  <h1>Sign in</h1>
  <p class="hint">This dashboard is the administrative view of a disclosed monitoring collector.
    Access is logged. Every approval, revocation, export, policy write and screenshot view is
    recorded in the audit log with your account name and address.</p>
  ${error ? `<div class="banner error">${esc(error)}</div>` : ''}
  <form data-action="login" autocomplete="off">
    <label>Account <input type="text" name="account" required></label>
    <label>Password <input type="password" name="password" required></label>
    <button type="submit" class="btn primary">Sign in</button>
  </form>
  <noscript><div class="banner">This page needs JavaScript for sign-in. The collector exposes the
    same surface as a documented JSON API for scripted use.</div></noscript>
</section>`;
}

// Filters are selects, not free text: the device filter is matched against a UUID column and a
// typed hostname would be refused with 400. A value in the query string that is no longer in the
// option list (a device that has since been deleted) is kept and shown so the URL never quietly
// widens the result set behind the operator's back.
function deviceField(options) {
  return { name: 'device', label: 'Device', allLabel: 'All devices', options };
}

// Device actors are stored as "device:<uuid>". The full id stays in the title so a screenshot of
// the audit log can still be read, but a column of 36-character strings is unreadable at a glance.
function shortActor(actor) {
  const m = /^device:([0-9a-f-]{36})$/i.exec(String(actor ?? ''));
  if (!m) return esc(actor ?? '—');
  return `<span title="${esc(actor)}">${esc(`device:${m[1].slice(0, 8)}`)}&hellip;</span>`;
}

export function filterForm(fields, hrefBase) {
  if (!fields.length) return '';
  const url = new URL(hrefBase, 'http://x');
  const controls = fields.map((f) => {
    const current = url.searchParams.get(f.name) ?? '';
    const opts = [`<option value="">${esc(f.allLabel ?? 'All')}</option>`];
    for (const o of f.options) {
      opts.push(`<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`);
    }
    if (current && !f.options.some((o) => o.value === current)) {
      opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
    }
    return `<label class="filter"><span>${esc(f.label)}</span>`
      + `<select name="${esc(f.name)}">${opts.join('')}</select></label>`;
  }).join('');
  return `<form class="filters" method="get" action="${esc(url.pathname)}">${controls}
    <button type="submit" class="btn">Apply</button></form>`;
}

export function pager({ next, hasMore, hrefBase }) {
  if (!hasMore || next === null || next === undefined) return '';
  const url = new URL(hrefBase, 'http://x');
  url.searchParams.set('cursor', String(next));
  return `<p class="pager"><a class="btn" href="${esc(url.pathname + url.search)}">Older</a>
    <span class="sub">next cursor ${esc(next)}</span></p>`;
}

export const KEY_NOTES = {
  screenshot_interval_minutes: 'How often an approved agent captures a frame.',
  screenshot_retention_days: 'Server-side age at which the sweeper deletes stored images.',
  screenshot_max_bytes: 'Bigger captures are dropped on the device before upload.',
  clipboard_metrics_enabled: 'Off stops sampling entirely; nothing is queued while it is off.',
  extension_inventory_enabled: 'Off stops the browser profile read completely.',
  clipboard_sample_seconds: 'How often the clipboard is hashed in memory on the device.',
  heartbeat_interval_seconds: 'Control-plane poll; policy deltas arrive here.',
  batch_max_items: 'Flush when this many events are spooled.',
  batch_max_bytes: 'Flush when the spooled NDJSON reaches this size.',
  batch_max_age_seconds: 'Flush even a partial batch once the oldest event is this old.',
  spool_max_bytes: 'Spool cap. Past it, oldest whole segments are dropped and reported.',
  skip_when_locked: 'No capture while the workstation is locked.',
  idle_skip_seconds: 'No capture while input has been idle this long.',
  dedupe_unchanged_frames: 'Skip a frame whose perceptual hash matches the previous one.',
  ext_inventory_max_age_hours: 'Minimum age of a cached profile hash before re-reading.',
};

export function parseArray(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Only an unfiltered first page is polled. A deep cursor page refreshed against the newest
// fragment would silently replace the rows the operator had scrolled to.
function pollAttr(poll) {
  return poll ? ` data-poll="${esc(poll)}"` : '';
}

export function pageHelp() {
  return `<section class="region help">
  <div class="regionhead"><h2>How this works</h2></div>
  <p>Two programs. The <strong>collector</strong> is the one serving this page: it keeps the database and
  shows you what it received. An <strong>agent</strong> is the small program installed on each computer,
  which sends that data. Nothing is collected from a computer until three things have happened, in order.</p>
  <ol>
    <li><strong>The person is told.</strong> On their computer the agent prints a plain-English notice
    saying what is watched and how often. They read it and type their own name to agree, or type
    <em>no</em> to refuse. Refusing writes a <span class="mono">DECLINED.txt</span> file and that
    computer never sends anything.</li>
    <li><strong>The agreement is recorded.</strong> Their name and the exact wording they agreed to are
    stored, and appear on that device's page. That is a record of consent, not of their activity.</li>
    <li><strong>An admin approves.</strong> Someone clicks Approve in the approval queue on Overview.
    Until that click the agent has nowhere to send data, even if the person agreed.</li>
  </ol>
  <p>Approving is not permanent: revoking a device puts it back through steps 1 to 3, and editing the
  notice wording on the Policy page sends every device back to step 1.</p>
</section>
<section class="region help">
  <div class="regionhead"><h2>The pages along the top</h2></div>
  <dl>
    <dt>Overview</dt><dd>Totals, and the approval queue: computers waiting for a decision.</dd>
    <dt>Screenshots</dt><dd>The captured frames, newest first. Filter to one computer.</dd>
    <dt>Extensions</dt><dd>Which browser add-ons are installed, per computer.</dd>
    <dt>Clipboard</dt><dd>Counts only: how much was copied, and roughly what kind of thing it was.</dd>
    <dt>Telemetry health</dt><dd>Which computers are still reporting. Use it to spot one that has stopped.</dd>
    <dt>Audit log</dt><dd>Every approval, revocation and policy change, with who and when.</dd>
    <dt>Policy</dt><dd>How often screens are captured, how long they are kept, and the notice wording.</dd>
  </dl>
</section>
<section class="region help">
  <div class="regionhead"><h2>What this system cannot do</h2></div>
  <div class="noticebox"><strong>There is no text here to read.</strong> Clipboard content is hashed in
  the agent's memory, and only that hash, a character count and a coarse label are ever sent. No column
  in the database could hold the words, no log line writes them, and screenshots are stored as pictures
  -- never read by optical character recognition or any other image analysis.</div>
  <p>It also never hides itself. There is no process or task hiding, no interference with antivirus, and
  no way to install it on a computer from elsewhere: someone has to run the installer while that person
  is signed in.</p>
</section>
<section class="region help">
  <div class="regionhead"><h2>On a computer being monitored</h2></div>
  <p>Everything lives in one folder, <span class="mono">C:\\ProgramData\\CTTIme</span>. Inside it
  <span class="mono">ABOUT.txt</span> says in plain words what is installed, the agent itself is
  readable JavaScript rather than a compiled blob, and <span class="mono">agent.log</span> records what
  it did -- including every time it refused to collect. A device user can read all of it without any
  permission beyond opening the folder.</p>
  <p>To stop and remove it, run <span class="mono">uninstall.ps1</span> in that folder. The scheduled
  task is named <span class="mono">CTTIme Endpoint Visibility</span> and appears in
  <span class="mono">schtasks /query</span> and in Task Scheduler. It runs only while that person is
  signed in, under their own limited account, and stores no password anywhere.</p>
  <h3>Network</h3>
  <p>One port: <span class="mono">8443</span>, encrypted, carrying both this page and the agents'
  uploads. Agents connect outward and listen on nothing. There is no unencrypted fallback.</p>
  <div class="callout"><strong>Every login to this dashboard is a full administrator.</strong> Anyone who
  can sign in can approve devices and read every screenshot. Make one account per person and do not share
  it.</div>
</section>`;
}
