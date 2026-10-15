-- CTTIme collector schema. Loaded by server/lib/db.js on a fresh database only.
-- Clipboard note: there is deliberately no column anywhere in this file capable of holding
-- clipboard text. clipboard_metrics stores a count, a hash, and a kind label. Do not add one.

PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  os_build TEXT NOT NULL,
  device_user TEXT NOT NULL,
  lan_ip TEXT,
  agent_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (state IN ('pending_approval','approved','rejected','revoked')),
  token_hash TEXT,
  enrolled_at TEXT NOT NULL,
  last_seen_at TEXT,
  notice_version TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  revoked_by TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  policy_etag TEXT,
  spool_dropped INTEGER NOT NULL DEFAULT 0,
  spool_bytes INTEGER,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  last_flush_at TEXT,
  last_flush_ms INTEGER,
  -- Registration round-trip. These three answer "did the approval actually reach the device, and
  -- did anything real come back?", which the state column alone cannot: a device can be approved
  -- and never call in. Each is written at most once, by the code that observes the event.
  token_delivered_at TEXT,
  first_contact_at TEXT,
  first_data_at TEXT
);

-- Consent is a database invariant, not an application-layer courtesy. A device cannot reach
-- 'approved' while any of the three notice-record fields is missing, no matter which code path
-- issues the UPDATE -- the admin API, a future script, or a hand-typed sqlite session.
--
-- The empty-string checks matter: a NULL-only guard is satisfied by an enrollment that stored
-- acknowledged_by = '', which is how a "consent record" ends up being a blank field.
--
-- What this does NOT do: it cannot verify that acknowledged_by is the real device user, or that
-- the acknowledgment was given freely rather than under instruction. It enforces that a record
-- exists and is non-blank. See docs/LAWFUL-USE.md.
CREATE TRIGGER devices_require_consent_before_approval
BEFORE UPDATE OF state ON devices
WHEN NEW.state = 'approved'
  AND (
    NEW.acknowledged_at IS NULL
    OR NEW.acknowledged_by IS NULL
    OR TRIM(NEW.acknowledged_by) = ''
    OR NEW.notice_version IS NULL
    OR TRIM(NEW.notice_version) = ''
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot approve a device with no recorded notice acknowledgment');
END;

-- Re-enrollment and state edits must not launder a revocation. Only an explicit admin re-enable
-- (which writes 'rejected') can move a revoked row, and never straight back to 'approved' from
-- SQL. Consent history is evidence and survives state changes, so freshness -- not deletion --
-- is what re-enable relies on: the admin route refuses to approve a device whose acknowledgment
-- predates its revocation.
CREATE TRIGGER devices_revoked_stays_revoked
BEFORE UPDATE OF state ON devices
WHEN OLD.state = 'revoked' AND NEW.state = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'a revoked device cannot be re-approved; an admin must re-enable the row first');
END;

CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  phash TEXT,
  storage_key TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One inventory EVENT expands to one row PER EXTENSION, so event_id cannot be unique here: a
-- profile with two extensions would violate it on its very first submission and take the whole
-- batch transaction down with it. Idempotency of a re-delivered event lives on the composite key
-- below, which is identical for every row of the same event. Do not add UNIQUE(event_id).
CREATE TABLE extension_inventory (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  browser TEXT NOT NULL,
  profile TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  name TEXT,
  version TEXT,
  source TEXT,
  permissions TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(device_id, browser, profile, ext_id, collected_at)
);

CREATE TABLE clipboard_metrics (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL UNIQUE,
  sampled_at TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_kind TEXT
);

CREATE TABLE screen_states (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL UNIQUE,
  sampled_at TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE policy (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- One row per policy revision the collector has served, so a heartbeat reporting "I hold etag X"
-- can be answered with the delta between X and now. Without this the server could not compute a
-- diff, because the agent's only statement of state is an etag.
CREATE TABLE policy_snapshots (
  etag TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The agent reports a cumulative bytes_sent counter at each heartbeat. Differencing sampled
-- values is how "bytes this hour" is answered without the agent keeping its own window.
CREATE TABLE device_traffic (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  ts TEXT NOT NULL,
  bytes_sent INTEGER NOT NULL,
  spool_bytes INTEGER,
  spool_dropped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_traffic_device_time ON device_traffic(device_id, ts DESC);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT
);

-- Admin accounts live in the database, seeded at boot from server/accounts.json or the
-- bootstrap env var. There is no default password: if neither source exists the dashboard
-- refuses to serve a login page and prints an instruction instead.
CREATE TABLE admin_accounts (
  account TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE INDEX idx_shots_device_time ON screenshots(device_id, captured_at DESC);
CREATE INDEX idx_shots_expiry ON screenshots(expires_at);
CREATE INDEX idx_state ON devices(state);
CREATE INDEX idx_ext_device_time ON extension_inventory(device_id, collected_at DESC);
CREATE INDEX idx_clip_device_time ON clipboard_metrics(device_id, sampled_at DESC);
CREATE INDEX idx_screen_state_device_time ON screen_states(device_id, sampled_at DESC);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);

-- Policy defaults. Transport tunables live here so the agent hardcodes nothing; the agent's
-- own fallback defaults are documented in docs/API-CONTRACT.md section 5 and only apply when a
-- key is absent from this table.
INSERT INTO policy (key, value, updated_at, updated_by) VALUES
  ('screenshot_interval_minutes', '5',       datetime('now'), 'system'),
  ('screenshot_retention_days', '30',        datetime('now'), 'system'),
  ('screenshot_max_bytes', '8388608',        datetime('now'), 'system'),
  ('clipboard_metrics_enabled', 'true',      datetime('now'), 'system'),
  ('extension_inventory_enabled', 'true',    datetime('now'), 'system'),
  ('notice_version', '2026-10-15.2',         datetime('now'), 'system'),
  ('collector_bind', '0.0.0.0',              datetime('now'), 'system'),
  ('collector_port', '8443',                 datetime('now'), 'system'),
  ('heartbeat_interval_seconds', '300',      datetime('now'), 'system'),
  ('clipboard_sample_seconds', '60',         datetime('now'), 'system'),
  ('batch_max_items', '200',                 datetime('now'), 'system'),
  ('batch_max_bytes', '262144',              datetime('now'), 'system'),
  ('batch_max_age_seconds', '120',           datetime('now'), 'system'),
  ('spool_max_bytes', '134217728',           datetime('now'), 'system'),
  ('skip_when_locked', 'true',               datetime('now'), 'system'),
  ('idle_skip_seconds', '600',               datetime('now'), 'system'),
  ('dedupe_unchanged_frames', 'true',        datetime('now'), 'system'),
  ('ext_inventory_max_age_hours', '24',      datetime('now'), 'system');
