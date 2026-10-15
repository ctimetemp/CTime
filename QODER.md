# CTTIme Endpoint Visibility — project ground rules

## What this project is

A **disclosed** endpoint-monitoring collector for company-managed Windows devices. It is the
same product category as commercial employee-monitoring / DLP tooling (ActivTrak, Teramind,
Hubstaff) and it is expected to be deployed under a signed Acceptable Use Policy.

Nothing here is intended to run unnoticed. If a change makes the agent harder for the device
owner or the IT staff to find, that change is a bug, not a feature.

## Non-negotiables

Do not weaken, bypass, or "temporarily" remove any of these, and do not add capabilities that
imply them. If a requirement conflicts with one, the requirement loses.

1. **Discoverability.** The agent registers a Task Scheduler job with a human-readable name,
   keeps a plaintext `config.json` stating what it collects, writes a local log the device user
   can read, and exposes a "What this collects" window. An admin must find it with
   `schtasks /query` and `Get-Process`.
2. **Consent gate.** The database refuses to move a device to `approved` without a recorded
   notice acknowledgment and acknowledger name (`devices_require_consent_before_approval`).
   Bumping `notice_version` returns every device to pending.
3. **Clipboard is metrics-only.** Character count, SHA-256, and a kind label. No column, field,
   log line, spool record or code path may carry clipboard text. Inbound requests containing a
   `content`/`text` key are rejected outright and audit-logged.
4. **Screenshots are interval-based with server-enforced retention.** No OCR, no on-image text
   extraction, no analysis of screenshot pixels. Permanently out of scope.
5. **Never admin-defeating.** No process or service hiding, no AV/EDR interference, no
   persistence designed to survive forensic inspection, no credential theft.

## Scope discipline

`docs/README.md` → "Not in v1" is a deferral list that protects the schedule, not a backlog to
work through opportunistically. Adding a deferred item needs an explicit request.

## Build rules

- Node.js, **zero npm runtime dependencies**. The collector box may have no internet.
- Database: built-in `node:sqlite` (`DatabaseSync`) only. No compiled drivers.
- `docs/API-CONTRACT.md` is the source of truth between the two halves of the build. If you
  change a wire format, change the contract in the same commit.
- Windows capture uses PowerShell (`System.Drawing`); no native modules.
- Dashboard: server-rendered HTML + vanilla JS + hand-written CSS. No build step, no framework,
  no CDN.
