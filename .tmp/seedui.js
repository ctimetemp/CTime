// Seeds a scratch collector's database with one device per verification verdict so the redesigned
// dashboard can be looked at, not just reasoned about. Only ever pointed at a throwaway
// CTTIme_DATA directory; the acknowledged_by values are labelled synthetic.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const dbPath = process.argv[2];
if (!dbPath) throw new Error('usage: node .tmp/seedui.js <path to collector.db>');
const db = new DatabaseSync(dbPath);

const now = (offsetMinutes = 0) =>
  new Date(Date.now() + offsetMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19);

function device({ hostname, state, ack, stamps, seenMinutesAgo = 2, user }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, fingerprint, hostname, os_build, device_user, lan_ip,
      agent_version, state, enrolled_at, last_seen_at, notice_version, acknowledged_by,
      acknowledged_at, approved_by, approved_at, policy_etag,
      token_delivered_at, first_contact_at, first_data_at, spool_bytes, spool_dropped, bytes_sent)
    VALUES (?, ?, ?, '10.0.26200 x64', ?, '10.20.4.15', '1.0.0', ?, ?, ?, '2026-10-15.1', ?, ?,
      ?, ?, '"seed"', ?, ?, ?, 3145728, 12, 4718592)`)
    .run(id, crypto.randomUUID().replace(/-/g, ''), hostname, user, state, now(),
      now(-60 - seenMinutesAgo),
      ack ? 'SYNTHETIC UI REVIEW - not a real person' : null,
      ack ? now(-90) : null,
      state === 'approved' || state === 'revoked' ? 'itadmin' : null,
      ack && ack !== 'none' ? now(-80) : null,
      stamps.token, stamps.contact, stamps.data);
  return id;
}

const none = { token: null, contact: null, data: null };
const rows = [
  ['FIN-WS-014', 'pending_approval', false, none, 3],
  ['FIN-WK-002', 'approved', true, { token: null, contact: null, data: null }, 14],
  ['OPS-LT-113', 'approved', true, { token: now(-20), contact: null, data: null }, 22],
  ['DEV-DK-007', 'approved', true, { token: now(-45), contact: now(-44), data: null }, 1],
  ['OPS-SRV-001', 'approved', true, { token: now(-300), contact: now(-299), data: now(-298) }, 1],
  ['HR-LT-088', 'revoked', true, { token: now(-900), contact: now(-899), data: now(-898) }, 610],
];

for (const [hostname, state, ack, stamps, seen] of rows) {
  const id = device({ hostname, state, ack: ack ? 'yes' : false, stamps, seenMinutesAgo: seen,
    user: hostname.split('-')[0].toLowerCase() + '.user' });
  // The working device gets real child rows so the detail page and the tally have something to show.
  if (stamps.data) {
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO extension_inventory (event_id, device_id, collected_at, browser, profile,
        ext_id, name, version, source, permissions, enabled)
      VALUES (?, ?, ?, 'chrome', 'Default', 'abcdefghijklmnopabcdefghijklmnopabcd', 'Corporate SSO',
        '4.1.0', 'webstore', '["tabs","storage"]', 1)`)
      .run(crypto.randomUUID(), id, now(-5));
    db.prepare(`INSERT INTO clipboard_metrics (event_id, device_id, sampled_at, char_count,
        sha256, content_kind) VALUES (?, ?, ?, 42, ?, 'other')`)
      .run(crypto.randomUUID(), id, now(-4), crypto.createHash('sha256').update('x').digest('hex'));
    db.prepare(`INSERT INTO screen_states (event_id, device_id, sampled_at, state)
      VALUES (?, ?, ?, 'active')`).run(crypto.randomUUID(), id, now(-3));
    db.prepare(`INSERT INTO screenshots (event_id, device_id, captured_at, received_at, sha256,
        phash, width, height, bytes, storage_key, expires_at)
      VALUES (?, ?, ?, ?, ?, '3672dabbd9000081', 3440, 1440, 466944, ?, ?)`)
      .run(crypto.randomUUID(), id, now(-2), now(-2),
        crypto.createHash('sha256').update('png').digest('hex'),
        `${crypto.randomUUID()}.png`, now(60 * 24 * 30));
  }
}

const counts = db.prepare('SELECT state, count(*) n FROM devices GROUP BY state').all();
console.log(JSON.stringify(counts));
