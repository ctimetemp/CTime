# Lawful use

This is the boundary between what the software guarantees and what the deployment has to supply.
Read it before the first device is installed, and give it to whoever signs the Acceptable Use
Policy. It is not legal advice, and it is not a substitute for the policy — the policy is a document
your organisation has to write, review and sign, and this product is only lawful under it.

CTTIme is the same category of product as ActivTrak, Teramind or Hubstaff. It is the tooling half
of an employer/employee arrangement, not the arrangement itself.

## What the code enforces

These are properties of the build. A deployment cannot turn them off by configuration, and an
acceptance check exists for each of them (`node test/run.js`).

| Guarantee | Where it lives |
|---|---|
| A device cannot reach `approved` without a recorded, non-blank acknowledgment at the current notice version | `devices_require_consent_before_approval` trigger in `server/lib/schema.sql` |
| Clipboard text has nowhere to be stored: no column, no field, no log line | `clipboard_metrics` closed column set, `validateClipboardData`, §7.5 of the contract |
| An upload that carries a `content` or `text` key is refused as a whole batch and audit-logged, and none of its lines are written | `server/lib/routes/device.js` |
| Screenshots are never analysed: no OCR, no text extraction, no pixel analysis anywhere in the build | not in the code — the capability is absent by design and permanently out of scope |
| Publishing a notice version returns every device to pending; editing wording at the same version keeps consent | `notice_bump` in `server/lib/routes/admin.js` + the consent trigger |
| The device user is told, on their own screen and in their own session, when the device is registered, when it is approved and collection begins, when the collector becomes unreachable, when it is reachable again, and when its certificate cannot be verified -- and the same facts are written to a file they can read | `agent/lib/notify.js`, `client-py/CTTIme_agent/notify.py`, `pending-shots/notifications.json` |
| Stored screenshots are deleted on a fixed schedule, files before rows | `server/lib/retention.js`, hourly sweep |
| Traffic is TLS with the collector's certificate pinned by SHA-256; no plaintext route, no fallback, no downgrade. Extra listener ports are availability only: a pin mismatch never moves to the next port | `agent/lib/transport.js`, `client-py` transport |
| The agent is visible: named Task Scheduler job, plaintext `config.json`, plaintext `agent.log`, `ABOUT.txt`, `what-collects` command, `uninstall.ps1` | `scripts/install.ps1`, `agent/cli.js` |
| Revoking a device stops collection at the next request the agent makes, with a recorded reason | `/api/devices/:id/revoke`, `agent/index.js` gate |
| Every admin action — approval, revocation, policy edit, notice edit, export, and each screenshot opened — is written to an audit log with the account and IP | `audit_log`, `server/lib/routes/admin.js` |
| Nothing is collected from a declined device, and the refusal is recorded on the device | `DECLINED.txt`, the consent gate |

## What only the deployment can supply

The software can prove a name was typed under a notice on a date. It cannot prove any of the
following, and each of them is the employer's obligation:

- **The person who typed it was the device's user**, and not an administrator typing on their
  behalf. The installer deliberately does not acknowledge unless the operator passes the
  acknowledgment flag, and the flag names the operator rather than the user — an acknowledgment
  entered by someone else is not consent, it is a fabricated record.
- **The user understood the notice**, was not rushed, and was not told the agreement was a
  condition of keeping their job.
- **The purpose is legitimate, specific and stated.** Screenshots of a whole screen every few
  minutes are proportionate to "is this managed endpoint healthy and is approved software
  installed". They are hard to justify for "measure how long each keystroke takes".
- **Proportionality of the interval.** A one-minute interval on every device is a different
  intrusion from a ten-minute one on a sample. Choose the least that serves the stated purpose,
  and record why.
- **Prior, general notice.** Everyone covered has to know before installation, not at the moment
  the notice appears on their screen.
- **Consultation where local law requires it** — works council, employee representation, or the
  equivalent body. In several jurisdictions this is a precondition for deploying employee
  monitoring at all, and a signed AUP does not replace it.
- **A recorded assessment** for the categories of personal data actually captured. A screenshot of
  a whole screen can incidentally contain health messages, union correspondence, a personal inbox
  or a bank page. That risk is inherent to screen capture and is why the interval, the retention
  period and the access list matter.

## Rules that keep this on the disclosed side

The product is built to be found. Do not undo that:

- Do not monitor devices that are not company-managed. A personally owned device, or a family
  member's use of a company laptop, is a different question and needs a different answer.
- Do not deploy without the notice, and do not treat "they signed the AUP at hire" as the notice.
  The notice is what the agent serves, and the acknowledgment is what the database requires.
- Do not use it for a covert investigation. If you need to watch someone secretly, this is the
  wrong tool: it is visible by construction, and the acknowledgment trail will show what was
  collected and when. Covert monitoring is a legal question for a lawyer first.
- Do not read a screenshot as evidence of anything on its own. Screenshots are taken on an
  interval, so the gap between two frames is unknown, and the agent skips frames when the screen
  is unchanged; the dashboard marks those gaps as intentional. Absence of an image is not absence
  of activity.
- Do not harvest credentials. Passwords and session tokens are not collected by design; if a
  captured screen happens to show one, that is an incident to handle under your security policy,
  not material to file.
- Do not extend the collection. There is no keylogger, no browsing history, no clipboard content
  and no OCR, and each of those is deliberately out of scope. If a request appears for one of
  them, the answer is that this product does not do it.
- Do not share dashboard accounts. `node scripts/make-account.js <name>` per person, so the audit
  log names a human. Rotate before a person leaves.
- Do not keep data past the stated retention to "be safe". An unbounded retention turns a
  proportionate measure into a stockpile.

## Answering a request from a device user

For a request to see or remove the data held about a device:

1. **Copy** — the device page's `Export all data (JSON)` gives their events, screenshot metadata
   and extension rows. This is audited as `data_export`.
2. **Stop** — revoke the device with a reason. The agent stops collecting on its next request and
   the revocation is permanent evidence in the audit log.
3. **Remove** — v1 has no per-record erasure button. Either shorten `screenshot_retention_days`
   on the Policy page and let the hourly sweep age the frames out, or delete the rows and files
   directly while the collector is stopped:
   `DELETE FROM screenshots WHERE device_id = ?` plus the files named by their `storage_key`.
   The device row and its consent record are kept on purpose: the record that a person agreed,
   and that it was later withdrawn, is the audit trail that makes the rest of this credible.

## Uninstalling and leaving

`scripts/uninstall.ps1` stops and unregisters the task and removes the state folder, including the
sealed token and the local queue. `-KeepData` leaves the logs and queue for an audit. Nothing about
uninstallation requires hiding, and a device user who finds the task and asks IT to remove it
should get a date, not an obstacle.

## Jurisdiction

Employee monitoring, biometric-adjacent capture, and works-council obligations differ by country
and by state. Nothing in this repository asserts that a deployment built with it is lawful
somewhere. Before rollout, the signed policy has to state who is covered, what is collected, for
what purpose, for how long, who can look, and who reviews it — and that document has to exist
before the first device enrolls.
