# API Contract v1 — FROZEN

Status: frozen. Both the collector (`server/`) and the agent (`agent/`) build against this
document. A field that appears here but is handled by only one side is a defect. Changing a
wire format means changing this file in the same commit.

Transports: HTTPS only, TLS 1.2+, self-signed certificate pinned by SHA-256 of the
DER. There is no plaintext fallback and no negotiated downgrade — an agent that cannot verify
the pin aborts the request rather than sending it.

The collector may listen on more than one port (`CTTIme_PORT` plus `CTTIme_EXTRA_PORTS`). Every
listener shares one key, one certificate, one router and one session store, so **the port list is
availability, never identity**: the pin check is identical whichever listener answers, and the agent
moves to the next port only on a connection-level failure (`ECONNREFUSED`/timeout). A pin mismatch
or a missing certificate is terminal and must never trigger a port switch — rotating to another
port after a pin mismatch would treat an interception as a transient network fault.

All timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).
All sizes are bytes. All IDs the agent generates are lowercase UUIDv4.

---

## 1. Common request shape

```
Authorization: Bearer <device-token>        # every route except notice, enroll, enroll/status
X-Agent-Version: 1.0.0                      # informational, logged at heartbeat
Content-Encoding: gzip                      # /batch only
```

Device token is issued **once**, at the moment `enroll/status` first reports `approved`, and is
sealed with DPAPI into `%PROGRAMDATA%\CTTIme\token.bin`. It is never written as plaintext.

### Error envelope

Every non-2xx response on the device API is:

```json
{ "error": "machine_readable_code", "detail": "human sentence", "retry_after": 37 }
```

`retry_after` is present only on `429` and is the number of seconds to wait before the next
attempt for this endpoint.

| HTTP | `error` | Meaning | Agent behaviour |
|------|---------|---------|-----------------|
| 400 | `bad_request` | Body failed schema validation | Do **not** retry. Drop the offending event, increment `spool_dropped`, log locally. |
| 401 | `token_invalid` | Bearer token unknown | Do not retry. Re-enter enrollment flow. |
| 401 | `token_mismatch` | Token valid but not for this fingerprint | Do not retry. Halt, surface in local log. |
| 403 | `state_not_approved` | Device row exists but `state != 'approved'` | Do not retry. Keep spooling locally, keep heartbeating. |
| 403 | `notice_outdated` | `notice_version` was bumped since enrollment | Do not retry. Halt ingest until the user re-acknowledges. |
| 404 | `unknown_device` | Fingerprint/token pair not enrolled | Re-enroll. |
| 409 | `already_resolved` | Approve/reject on a device already in a terminal state | Admin API only. |
| 413 | `body_too_large` | Exceeds the policy size cap for this route | Do not retry the same body. Split, or drop and count. |
| 415 | `unsupported_media` | `Content-Type` is not what the route declares | Do not retry. Client bug. |
| 422 | `content_field_forbidden` | Clipboard payload carried a content/text field | Do not retry. Client bug, logged to `audit_log`. |
| 500 | `internal` | Collector fault | Retry with backoff. |
| 503 | `collector_busy` | Over capacity | Retry with backoff, honour `retry_after`. |

The agent treats any code not listed here as `internal` (retryable).

---

## 2. `GET /api/v1/notice` — no auth

The notice wording is authored server-side. The agent never hardcodes legal text.

```json
{ "version": "2026-10-15.1", "text": "…markdown…", "collects": ["screenshots","extension_inventory","clipboard_metrics"] }
```

Response headers: `ETag: "<version>"`, `Cache-Control: public, max-age=86400`.
Honours `If-None-Match` → `304` with an empty body.

The agent must display `text` verbatim at enrollment and must re-fetch when its stored
`notice_version` differs from `collects`' companion version.

## 3. `POST /api/v1/enroll` — no auth

Request:

```json
{
  "fingerprint": "sha256 hex, 64 chars",
  "hostname": "WORKSTATION-14",
  "os_build": "10.0.26100",
  "device_user": "a.novak",
  "agent_version": "1.0.0",
  "notice_version": "2026-10-15.1",
  "acknowledged_by": "A. Novak",
  "acknowledged_at": "2026-10-15T09:12:44.512Z"
}
```

`acknowledged_by` is the name **typed by the device user** at the enrollment screen. Empty,
whitespace-only, or longer than 200 chars → `400 bad_request`. `acknowledged_at` must be within
±10 minutes of server time, else `400 bad_request` (`detail: clock_skew`) — the agent must not
fabricate a plausible timestamp.

Response `202`:

```json
{ "device_id": "uuid", "state": "pending_approval" }
```

Re-enrolling an existing fingerprint is idempotent and returns the existing row; if that row was
`revoked`, the response is `202` with `state: "revoked"` and no token is ever issued again
without an admin-initiated re-enable.

## 4. `GET /api/v1/enroll/status?fingerprint=<fp>` — no auth

```json
{ "state": "pending_approval", "policy_etag": "\"a1b2\"" }
```

`state` ∈ `pending_approval | approved | rejected | revoked`.

When `approved` **and the device has no token yet**, the response additionally carries
`"token": "…"`. That token is returned exactly once — the collector records its hash and the
plaintext exists in no log, no spool file, and no further response. The agent seals it with
DPAPI before answering the caller. If the agent crashes between receiving and sealing, the
token is lost; the remedy is an admin rotating the device token, not a second delivery.

## 5. `GET /api/v1/config` — auth required

The complete policy document. The agent hardcodes no interval, flag or threshold.

```json
{
  "screenshot_interval_minutes": 5,
  "screenshot_retention_days": 30,
  "screenshot_max_bytes": 8388608,
  "clipboard_metrics_enabled": true,
  "extension_inventory_enabled": true,
  "clipboard_sample_seconds": 60,
  "notice_version": "2026-10-15.1",
  "heartbeat_interval_seconds": 300,
  "batch_max_items": 200,
  "batch_max_bytes": 262144,
  "batch_max_age_seconds": 120,
  "spool_max_bytes": 134217728,
  "skip_when_locked": true,
  "idle_skip_seconds": 600,
  "dedupe_unchanged_frames": true,
  "ext_inventory_max_age_hours": 24
}
```

Response headers: `ETag: "<sha256[0:16] of canonical JSON>"`, `Cache-Control: no-cache`.
Honours `If-None-Match` → **`304` with an empty body**. Byte length of a 304 response body is
required to be exactly 0.

Keys are additive: an agent ignores keys it does not know (forward compatibility) and applies
defaults for keys missing from the document (backward compatibility). Unknown keys are never
echoed back in an ack.

## 6. `POST /api/v1/heartbeat` — auth required

Request:

```json
{ "policy_etag": "\"a1b2\"", "spool_bytes": 1048576, "spool_dropped": 0, "bytes_sent": 81234 }
```

All four fields required; missing field → `400 bad_request`.

- **Nothing changed → `204`, empty body.** Byte length required to be exactly 0.
- **Something changed → `200`** with only the changed keys:

```json
{ "changed": { "screenshot_interval_minutes": 1 }, "removed": ["idle_skip_seconds"] }
```

`removed` lists keys the agent should reset to its own documented default. The agent applies the
diff and acks on its **next** heartbeat by sending the new `policy_etag`.

The collector also uses these fields to populate telemetry health. `spool_dropped` is reported,
not silently absorbed — a device that dropped events must be visibly gap-y in the dashboard.

A device whose `policy_etag` never advances to the current value is flagged `policy_stale`.

Header on any `200` config-diff response: `X-Policy-Etag: "<new etag>"`.

## 7. `POST /api/v1/batch` — auth required

Body: `Content-Encoding: gzip`, decompressed payload is **NDJSON** — one envelope object per
line, `\n`-separated, UTF-8, no trailing comma, no wrapping array, no pretty-printing.
Max compressed body: `batch_max_bytes`. Exceeded → `413 body_too_large`.

### Envelope

Every line has exactly this shape:

```json
{ "event_id": "uuid", "type": "clipboard_metric", "device_id": "uuid", "ts": "2026-10-15T09:15:02.113Z", "data": { } }
```

`event_id`, `type`, `device_id`, `ts` are required on every line. `data` is required and its
schema depends on `type`.

A line that is not valid JSON, or lacks a required envelope field, is counted in `malformed` and
skipped — one bad line does not reject the batch. **Exception:** the content-field rule in §7.5
rejects the whole batch.

### §7.1 `type: "clipboard_metric"`

```json
{ "sampled_at": "…", "char_count": 0, "sha256": "64 hex", "content_kind": "text | file-list | empty | image" }
```

`data` is validated against a **closed** key set: those four names and nothing else. A key named
`content`, `text`, `value`, `data`, `raw`, `payload`, `body`, `snippet`, or `preview` → §7.5.

### §7.2 `type: "extension_inventory"`

```json
{
  "collected_at": "…", "browser": "chrome | brave | edge | firefox", "profile": "Default",
  "extensions": [
    { "ext_id": "…", "name": "…", "version": "1.2", "source": "webstore | local | sideload",
      "permissions": ["tabs"], "enabled": true }
  ]
}
```

`extensions` is capped at 512 entries per event; over → `400 bad_request`.
`permissions` is capped at 64 entries and each at 256 chars. Strings are control-character
stripped and truncated to 512 chars at ingest, never rejected for length.

### §7.3 `type: "screen_state"`

```json
{ "sampled_at": "…", "state": "locked | idle | active" }
```

Emitted instead of a screenshot when capture was skipped by policy. One small event, zero pixels.

### §7.4 `type: "screenshot_skipped_unchanged"`

```json
{ "captured_at": "…", "sha256": "64 hex of last accepted frame", "phash": "16 hex" }
```

Records that a frame was captured, hashed, and matched the previous accepted frame, so the
dashboard can render the gap as **intentional** rather than missing. It does not reset the
retention clock.

### §7.5 Content-field rule (whole-batch rejection)

If **any** line in the batch carries a clipboard payload with a forbidden key, the collector:

1. rejects the **entire batch** with `422 content_field_forbidden`,
2. writes `audit_log` row (`actor: device:<id>`, `action: clipboard_content_rejected`,
   `detail` = offending `event_id`, `type` name and **key name only** — never the value),
3. records nothing from the batch — not the good lines, not the metadata of the bad line.

Whole-batch rejection is deliberate. Batching is where a future contributor could most easily
smuggle clipboard text through, and a partial-accept path would teach the agent to keep sending
it. The agent must treat `422` as terminal for that segment: drop it, increment `spool_dropped`,
and log locally that a client bug was detected.

### Response `200`

```json
{ "accepted": 198, "duplicates": 2, "malformed": 0, "unknown_types": 1 }
```

`accepted + duplicates + malformed + unknown_types` equals the number of lines. Idempotency is
carried by `event_id TEXT UNIQUE` + `INSERT … ON CONFLICT DO NOTHING`; a counted `duplicate` is
a successful no-op, so at-least-once delivery is lossless. The agent deletes the segment once the
server has answered for it — there is no per-event ack ledger.

`unknown_types` counts lines whose `type` the collector does not handle. They are not errors;
they let a newer agent talk to an older collector.

## 8. `POST /api/v1/screenshots` — auth required

Raw PNG, **not** base64, **not** inside JSON.

```
Content-Type: application/png
X-Captured-At: ISO-8601
X-Device-Id: uuid
X-Sha256: 64 hex
X-Event-Id: uuid
X-Phash: 16 hex            # optional; the perceptual hash computed at capture time
```

The collector pipes the socket to disk; it must not buffer the image in memory. Body length is
bounded against `screenshot_max_bytes` **while streaming** and the stream is aborted on overflow
→ `413`.

`400 bad_request` if the first 8 bytes are not the PNG signature, or `X-Sha256` mismatches the
bytes actually received (the collector computes it while streaming). Width/height are read from
the IHDR by the collector; the agent does not send them.

Response `201`: `{ "id": 4711 }`

`event_id` is UNIQUE. Re-uploading the same `event_id` → `200 { "id": <existing>, "duplicate": true }`
and the second body is discarded. This makes a retry after a lost response safe.

## 9. `POST /api/v1/clipboard-metric` — auth required

Single-event convenience route for tests. Body is the `data` object of §7.1, flat:

```json
{ "sampled_at": "…", "char_count": 12, "sha256": "…", "content_kind": "text" }
```

Same closed key set, same rejection: a `content` or `text` key → `422` + `audit_log`. The
validation is shared code with §7.5 so the two paths cannot drift.

---

## 10. Flush contract (agent side)

A flush fires when any of these is met, all values server-tunable:

- segment holds ≥ `batch_max_items` events, or
- segment ≥ `batch_max_bytes` compressed, or
- oldest buffered event ≥ `batch_max_age_seconds`, or
- a screenshot is due (screenshots ride the same connection, as a separate request).

Screenshot captures are never delayed behind a batch flush, and a batch flush never waits for a
capture. Order of a flush cycle: `heartbeat` → `batch` (chunked, see below) → `screenshots`.

**Chunking.** The first flush after approval may exceed one batch. The agent sends at most
`batch_max_items` per request and continues until the spool is drained; each request is
independently idempotent, so a mid-backfill failure resumes without duplicating rows.

**Retry.** Exponential backoff with full jitter: `sleep = random(0, min(cap, base * 2^attempt))`,
`base = 2s`, `cap = 120s`. A `429`/`503` honours `retry_after` if smaller, clamped to 300s of agent
patience: a collector that asks for a longer wait is believed about the payload, not about the link,
because a device that sleeps fifteen minutes after the collector returns is a device that looks
broken from the operator's seat. Keep-alive on a single
`https.Agent` is fine and a flush must not pay a handshake for every request -- but the client-side
TLS **session cache** must be off (`maxCachedSessions: 0`). A resumed TLS session is an abbreviated
handshake in which the server sends no certificate, so a connection established from a cached
session gives the pin nothing to compare against. The correct response to an absent certificate is
to refuse the connection, never to treat "no certificate" as already verified: that would trust a
session an attacker set up.

**Backoff applies per endpoint.** A failing screenshot route must not stall the event batch.

**Connection watch.** The heartbeat outcome additionally drives a link state machine in the agent:
`offline` on a retryable failure, `online` on a success that follows a known non-`unknown` state,
`unverified` on `tls_pin_mismatch` / `tls_no_certificate`. `offline` and `online` are terminal
states for the retry timer only in the sense that the next heartbeat resolves them; while
`offline`, the agent schedules its own retry capped at 60s regardless of the backoff the flush
asked for, so a collector that comes back is picked up in under a minute. Each transition is shown
to the device user as an on-screen notice (§10.1).

### §10.1 Notices to the device user

The agent tells the person at the keyboard, in their own session, when:

| kind | when | throttled to |
|------|------|--------------|
| `offline` | the collector became unreachable | 60s |
| `online` | the collector answered again after a gap | 60s |
| `unverified` | the presented certificate did not match this device's pin | 60s, re-announced on every recurrence |
| `registered` | the user's acknowledgment reached the collector | 6h |
| `approved` | the collector approved this device and collection began | 6h |
| `collecting` | hourly summary of what was sent, quoting the flusher's own counters | 20h |

The notices carry no collected data — no screenshot, no clipboard field, no keystroke. Wording is
fixed in the client (`agent/lib/notify.js`, `CTTIme_agent/notify.py`), capped at 63 title / 240
text characters because a balloon that clips cuts the sentence off, and every attempt is recorded in
`%PROGRAMDATA%\CTTIme\pending-shots\notifications.json` so `status` can show what the user was and was
not told. A notice that cannot be displayed is logged and does not change collection: it is
disclosure, not a control. `one-shot` and `check` never show a notice.

## 11. Admin API

Session cookie: HttpOnly + SameSite=Strict + Secure. Every mutation requires
`X-CSRF-Token`, read from the login response body, or → `403 csrf_failed`.
Login failures are rate-limited (5 per account per 15 min, then `429`) and written to `audit_log`.

```
POST   /api/login                  {account, password} -> {csrf, expires_at}
POST   /api/logout
GET    /api/account-status         -> {accounts, claimable}   — no session, count only, no names
POST   /api/claim                  {account, password, code} -> 201 {account, csrf, expires_at} + session
GET    /api/devices?state=&cursor=
GET    /api/devices/:id
GET    /api/devices/:id/verify     -> round-trip verdict for one device (see §11.1)
POST   /api/devices/:id/approve
POST   /api/devices/:id/reject
POST   /api/devices/:id/revoke     {reason}  — reason required, empty -> 400
GET    /api/screenshots?device=&from=&to=&cursor=&limit=
GET    /media/screenshots/:id      — streams through the session check; the directory is never static
GET    /api/extensions?device=&browser=&cursor=
GET    /api/clipboard?device=&cursor=
GET    /api/audit?cursor=&limit=
GET    /api/policy                 -> {policy, etag}
PUT    /api/policy                 {changed:{...}} -> {etag}; agent-visible on next heartbeat
POST   /api/policy/notice          {version, text} -> saves wording; a changed version also resets all devices to pending
GET    /api/telemetry-health
POST   /api/export/:device         -> writes an audit row, streams JSON
```

Every list route is cursor-paginated with `limit` default 100, max 500. There is **no**
"fetch all screenshots" endpoint. All admin JSON GETs honour `If-None-Match` → `304`.

### First run: `POST /api/claim`

A collector ships with no credential of any kind, so logins are refused until an account exists.
`/api/claim` is the way through that wall without a console:

* `code` is a 15-character random value (unambiguous alphabet, no `0O1IL`) generated by the
  collector on its first boot with no accounts. It is printed on the console in `XXXXX-XXXXX-XXXXX`
  form and stored in `DATA/first-run-code.txt` (`0600`) so a reboot does not invalidate it.
* It is compared with `timingSafeEqual` after normalising case, spaces and dashes. A wrong code is
  `403 bad_setup_code` and consumes the same per-account/per-IP login budget as a wrong password.
* The endpoint is refused with `409 already_claimed` the moment `admin_accounts` is non-empty, and
  a successful claim **deletes the code file**. It is not a default password: it cannot sign
  anything in, it authorises exactly one account creation, and it is unreachable without read
  access to the collector's own disk.
* Claiming returns a session and CSRF token, so the operator lands on the dashboard.
* Later accounts are still created from a console with `node scripts/make-account.js <name>`.
* `/api/account-status` is the unauthenticated way the sign-in page decides which form to render;
  it returns a count and nothing else.

### §11.1 Round-trip verification

`state` records what an administrator decided. It cannot answer "is this device actually
collecting", which is the question an operator asks after approving one. Three stamps are written
by the code that observes each step — `devices.token_delivered_at`, `devices.first_contact_at`,
`devices.first_data_at` — and the verdict is derived from them plus the consent fields, never
stored. `GET /api/devices/:id`, `GET /api/devices` (per row, as `verification`) and
`GET /api/devices/:id/verify` all return the same object, computed by the same function the
dashboard renders, so the two surfaces cannot disagree:

```
{ verdict, headline, tone, detail, steps: [
    { key: 'acknowledged', label, done, at, ago_ms },
    { key: 'approved',     label, done, at, ago_ms },
    { key: 'token',        label, done, at, ago_ms },
    { key: 'contact',      label, done, at, ago_ms },
    { key: 'data',         label, done, at, ago_ms } ] }
```

`verdict` is the first useful answer, in this order: `revoked`, `rejected`, `awaiting_approval`,
`token_pending` (approved, agent has not collected its token), `no_contact` (token delivered, no
authenticated request yet), `no_data` (authenticated and reporting, nothing accepted yet), `silent`
(more than three heartbeat intervals since `last_seen_at`), `working`. `/verify` additionally
returns `working: true|false`, `counts` and `policy_stale`, and writes a `device_verify` audit row.

`POST /api/devices/:id/approve` clears the three stamps in the same statement, so a re-approval
after a revocation cannot inherit the previous round trip's verdict.

### Policy write rules

`PUT /api/policy` rejects keys not in the §5 set (`400 bad_request`, `detail` names the key) and
rejects values outside the server's own bounds, so an admin cannot publish a policy that
self-DDoSes the LAN:

| key | bounds |
|-----|--------|
| `screenshot_interval_minutes` | 1–1440 |
| `screenshot_retention_days` | 1–365 |
| `heartbeat_interval_seconds` | 30–3600 |
| `batch_max_items` | 1–1000 |
| `batch_max_bytes` | 8192–4194304 |
| `batch_max_age_seconds` | 10–3600 |
| `spool_max_bytes` | 8388608–1073741824 |
| `screenshot_max_bytes` | 65536–33554432 |
| `idle_skip_seconds` | 0–86400 |
| `ext_inventory_max_age_hours` | 1–720 |

Boolean keys must be `true`/`false`, not strings. `collector_bind` / `collector_port` are
read-only over this route — they change by editing the server config file and restarting,
because a wrong value bricks the collector's own listen address.

### Notice publication

`POST /api/policy/notice {version, text}` answers `{ok, version, returned_to_pending}`.

- A version **different** from the one in force replaces the wording and moves every `approved`
  device to `pending_approval` (clearing `approved_by`/`approved_at`). Consent is never inherited
  across a bump. Each device must re-acknowledge in its own window before ingest resumes; ingest
  from a device still holding the old version is refused with `403 notice_outdated`, and approval
  on the strength of an old acknowledgment is refused the same way.
- Saving **new text at the version already in force** replaces what future notices show and keeps
  every existing consent (`returned_to_pending: 0`). That is the typo fix, and the Policy page says
  so in those words — the route must not silently strip consent that was given for this version.

The operator who publishes a bump cannot acknowledge on the device users' behalf; the name in
`acknowledged_by` is theirs, typed in front of the wording being acknowledged.

## 12. Versioning

Path carries the major version (`/api/v1/`). Additive changes (new optional field, new `type`,
new policy key) are v1-compatible and must be ignored by the other side. Anything a client
cannot safely ignore is a new major version. `GET /api/v1/config` is the only place defaults are
negotiated; neither side may assume the other's defaults match without the `removed` mechanism.

### Additions made during the build

Two fields not in the original brief were added, both because the brief forbade the alternative:

- **`clipboard_sample_seconds`** (default 60, bounds 15–3600). The requirement "no agent hardcodes
  an interval, flag or threshold" cannot be met by a clipboard sampler with no server-owned
  interval. Adding the key is what keeps the sampler's cadence server-authoritative.
- **`X-Phash`** (§8, optional). Lets the perceptual hash computed at capture time be stored with
  the frame it describes, so the dashboard can show *why* a later frame was deduped against it.
  Omitting it leaves `screenshots.phash` NULL and changes nothing else.
