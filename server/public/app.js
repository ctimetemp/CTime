// Dashboard behaviour. The HTML of every region is rendered by the collector; this script only
// re-fetches those fragments with If-None-Match and posts mutations to the JSON API. There is no
// client-side templating, so a refreshed region is identical in structure to the first render.
(() => {
  'use strict';

  const POLL_MS = 20000;
  const csrf = document.querySelector('meta[name="csrf"]')?.content || '';
  const etags = new Map();
  let failures = 0;
  let staleEl = null;

  class ApiError extends Error {
    constructor(status, code, detail) {
      super(detail || code || String(status));
      this.status = status;
      this.code = code;
    }
  }

  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrf;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (res.status === 401) { location.assign('/login'); throw new ApiError(401, 'login_required', 'session expired'); }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* export and fragments are not JSON */ }
    if (!res.ok) throw new ApiError(res.status, json?.error, json?.detail ?? text.slice(0, 180));
    return json ?? {};
  }

  // ---- regions -------------------------------------------------------------

  function regions() {
    return Array.from(document.querySelectorAll('section[data-poll]'));
  }

  // A refresh that replaces a region the operator is reading is worse than a stale one: drop it
  // and try on the next tick instead of pulling focus or discarding an open permissions list.
  function busy(el) {
    if (el.contains(document.activeElement)) return true;
    const sel = window.getSelection?.();
    return Boolean(sel && !sel.isCollapsed && el.contains(sel.anchorNode));
  }

  async function refresh(el) {
    const url = el.dataset.poll;
    const headers = {};
    const known = etags.get(url);
    if (known) headers['if-none-match'] = known;
    const res = await fetch(url, { headers, credentials: 'same-origin' });
    if (res.status === 304) { markFresh(); return false; }
    if (!res.ok) throw new ApiError(res.status, undefined, `fragment ${url} -> ${res.status}`);
    const etag = res.headers.get('etag');
    if (etag) etags.set(url, etag);
    const html = await res.text();
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('section[data-poll]');
    if (!next) return false;
    el.replaceWith(next);
    localize(next);
    return true;
  }

  async function refreshAll() {
    for (const el of regions()) {
      if (busy(el)) continue;
      try { await refresh(el); } catch (err) { noteFailure(err); }
    }
  }

  function noteFailure(err) {
    failures += 1;
    if (failures === 3) showStale('Live updates paused: the collector is unreachable.');
    if (err.status === 401) showStale('Session expired.');
  }

  function markFresh() {
    if (failures > 0) failures = 0;
    hideStale();
  }

  function showStale(text) {
    if (!staleEl) {
      staleEl = document.createElement('div');
      staleEl.className = 'banner error stalepoll';
      document.body.appendChild(staleEl);
    }
    staleEl.textContent = text;
  }

  function hideStale() {
    if (staleEl) { staleEl.remove(); staleEl = null; }
  }

  let timer = null;
  function startPolling() {
    if (timer || !regions().length) return;
    timer = setInterval(() => { if (!document.hidden) refreshAll().catch(noteFailure); }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll().catch(noteFailure); });

  // ---- feedback ------------------------------------------------------------

  function flash(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `banner ${kind}`;
    el.textContent = message;
    document.querySelector('main').prepend(el);
    setTimeout(() => el.remove(), 6000);
  }

  function setNote(form, message, kind) {
    const note = form.querySelector('[data-role]');
    if (!note) { flash(message, kind); return; }
    note.textContent = message;
    note.className = `formnote ${kind ?? ''}`.trim();
  }

  function withBusy(btn, fn) {
    btn.disabled = true;
    return fn()
      .catch((err) => flash(err.detail || err.message || 'request failed', 'error'))
      .finally(() => { btn.disabled = false; });
  }

  // ---- local time ----------------------------------------------------------
  // The collector writes every timestamp in UTC and puts the instant in `datetime`, so the served
  // page is unambiguous without JavaScript. An operator comparing "03:12Z" against their own
  // wall clock mis-reads it by hours, so the same instant is reformatted here after first paint
  // and after every fragment swap; the UTC value stays available in the tooltip.
  const localFmt = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  function localize(root) {
    for (const el of root.querySelectorAll('time[datetime]')) {
      const iso = el.getAttribute('datetime');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      el.textContent = localFmt.format(d);
      el.title = `${iso.slice(0, 16).replace('T', ' ')} UTC`;
    }
    refreshRel(root);
  }

  function refreshRel(root) {
    const now = Date.now();
    for (const el of root.querySelectorAll('[data-at]')) {
      const d = new Date(el.getAttribute('data-at'));
      if (Number.isNaN(d.getTime())) continue;
      el.textContent = relText(now - d.getTime());
    }
  }

  function relText(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }

  // Mirror of render.js humanize(): the policy inputs stay in the unit the agent reads, but the
  // gloss under them has to follow the operator's typing, not the value loaded at page render.
  function gloss(key, value) {
    const v = Number(value);
    if (!Number.isFinite(v) || value === '') return '';
    if (key.endsWith('_bytes')) {
      if (v < 1024) return `${v} B`;
      if (v < 1048576) return `${(v / 1024).toFixed(0)} KiB`;
      if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MiB`;
      return `${(v / 1073741824).toFixed(2)} GiB`;
    }
    const DURATION = { _seconds: 1, _minutes: 60, _hours: 3600, _days: 86400 };
    const suffix = Object.keys(DURATION).find((s) => key.endsWith(s));
    if (!suffix) return '';
    const secs = v * DURATION[suffix];
    if (secs >= 86400 && secs % 86400 === 0) return `${secs / 86400} d`;
    if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} h`;
    if (secs >= 60 && secs % 60 === 0) return `${secs / 60} min`;
    return `${secs} s`;
  }

  function updateGloss(input) {
    const el = document.querySelector(`[data-unit-for="${CSS.escape(input.name)}"]`);
    if (el) el.textContent = gloss(input.name, input.value);
  }

  // ---- mutations -----------------------------------------------------------

  const DEVICE_ACTIONS = {
    approve: { confirm: (name) => `Approve collection on ${name}? The device must already hold a written acknowledgment of the current notice.`, body: () => ({}) },
    reject: { confirm: (name) => `Reject ${name}? Nothing will be collected from it.`, body: () => ({}) },
    reenable: { confirm: (name) => `Re-enable ${name} for re-approval? The device user must acknowledge the notice again first.`, body: () => ({}) },
    revoke: {
      confirm: (name) => `Revoke ${name}? Collection stops as soon as the agent next reports, and its token is deleted.`,
      body: () => {
        const reason = prompt('Reason for revocation (recorded in the audit log):');
        if (reason === null) return null;
        if (reason.trim() === '') { flash('A revocation reason is required.', 'error'); return null; }
        return { reason: reason.trim() };
      },
    },
  };

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn || btn.tagName !== 'BUTTON') return;
    const action = btn.dataset.action;
    if (!DEVICE_ACTIONS[action]) return;
    const spec = DEVICE_ACTIONS[action];
    if (!window.confirm(spec.confirm(btn.dataset.name))) return;
    const body = spec.body(btn.dataset.name);
    if (body === null) return;
    withBusy(btn, async () => {
      const out = await api('POST', `/api/devices/${btn.dataset.id}/${action}`, body);
      flash(`${btn.dataset.name}: ${out.state ?? action}`);
      etags.clear();
      await refreshAll();
    });
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    const action = form.dataset.action;
    if (!action) return;
    event.preventDefault();

    if (action === 'login') {
      const data = Object.fromEntries(new FormData(form));
      await withBusy(form.querySelector('button'), async () => {
        await api('POST', '/api/login', data);
        location.assign('/');
      });
      return;
    }

    if (action === 'claim') {
      const data = Object.fromEntries(new FormData(form));
      if (data.password !== data.confirm) {
        setNote(form, 'The two passwords do not match.', 'bad');
        return;
      }
      delete data.confirm;
      await withBusy(form.querySelector('button'), async () => {
        try {
          await api('POST', '/api/claim', data);
        } catch (err) {
          // api() sends a 401 to /login, which is the right answer for an expired session and the
          // wrong one for a mistyped code, so this call reports its own failures.
          setNote(form, err.code === 'bad_setup_code'
            ? 'That first-run code does not match this collector. It is printed on the console at boot.'
            : err.code === 'already_claimed'
              ? 'An administrator already exists. Sign in instead.'
              : `${err.code ?? 'claim failed'}: ${err.message}`, 'bad');
          return;
        }
        location.assign('/');
      });
      return;
    }

    if (action === 'policy') {
      const changed = {};
      for (const el of form.querySelectorAll('[data-kind]')) {
        const value = el.dataset.kind === 'bool' ? el.value : Number(el.value);
        if (String(value) !== String(el.dataset.original)) changed[el.name] = value;
      }
      if (Object.keys(changed).length === 0) { setNote(form, 'No value changed.', 'ok'); return; }
      const button = form.querySelector('button[type=submit]');
      await withBusy(button, async () => {
        const out = await api('PUT', '/api/policy', { changed });
        for (const el of form.querySelectorAll('[data-kind]')) el.dataset.original = el.value;
        setNote(form, `Saved ${Object.keys(changed).join(', ')} · new etag ${out.etag}. Agents pick this up on their next heartbeat.`, 'ok');
        etags.clear();
      });
      return;
    }

    if (action === 'notice') {
      const data = Object.fromEntries(new FormData(form));
      await withBusy(form.querySelector('button'), async () => {
        const out = await api('POST', '/api/policy/notice', data);
        setNote(form, `Notice ${out.version} published; ${out.returned_to_pending} device(s) returned to the approval queue.`, 'bad');
        etags.clear();
        await refreshAll();
      });
    }
  });

  // Export is a download, not a JSON call: the payload can be large and must keep its filename.
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="export"]');
    if (!btn) return;
    withBusy(btn, async () => {
      if (!window.confirm(`Export everything collected for ${btn.dataset.name}? The export is recorded in the audit log.`)) return;
      const res = await fetch(`/api/export/${btn.dataset.id}`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const text = await res.text();
        let detail = text.slice(0, 180);
        try { detail = JSON.parse(text).detail ?? detail; } catch { /* not JSON */ }
        throw new ApiError(res.status, undefined, detail);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `CTTIme-${btn.dataset.name}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="logout"]');
    if (!btn) return;
    withBusy(btn, async () => {
      await api('POST', '/api/logout', {});
      location.assign('/login');
    });
  });

  // Record what was loaded so the policy form can send only keys the operator actually edited.
  for (const el of document.querySelectorAll('form [data-kind]')) el.dataset.original = el.value;

  // A filter is a two-click action if it stays a form submit, and one if the select commits
  // itself; the URL is still a plain GET, so a filtered view remains linkable and pollable.
  for (const sel of document.querySelectorAll('form.filters select')) {
    sel.addEventListener('change', () => sel.form.requestSubmit());
  }
  document.addEventListener('input', (event) => {
    if (event.target.matches('input[type=number][name]')) updateGloss(event.target);
  });

  localize(document);
  setInterval(() => { if (!document.hidden) refreshRel(document); }, 60000);

  startPolling();
})();
