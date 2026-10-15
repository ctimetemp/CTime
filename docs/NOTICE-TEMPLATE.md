# Monitoring Notice

Version: `2026-10-15.2`

This wording is authored on the collector and served to every device from
`GET /api/v1/notice`. The agent contains no legal text, so changing the notice is a server-side
edit that returns every device to pending until each user re-acknowledges.

The text below is a template. It must be reviewed by whoever owns the Acceptable Use Policy before
deployment, and the local works council or employee-representative body must be consulted wherever
local law requires it. Do not deploy this file unedited on the assumption that it is compliant
with your jurisdiction's rules on employee monitoring.

---

<!-- NOTICE-BEGIN: everything between these markers is served verbatim to the device user by
GET /api/v1/notice. Text outside it is authoring guidance and never reaches an endpoint. -->

## What is collected on this device

Your employer operates endpoint monitoring on this device using CTTIme Endpoint Visibility. This
device is company-managed. This software is not hidden from you or from the IT staff, and it is
registered as a named scheduled task you can see.

The following is collected:

**Screenshots of the entire screen**, taken on a fixed interval. The current interval is stated in
`%PROGRAMDATA%\CTTIme\config.json` on this device. Screenshots are not taken while the workstation
is locked, or while it has been idle longer than the configured idle threshold; those moments are
recorded as a state label with no image. When a captured screen is identical to the previous one,
the image is discarded on this device and never uploaded — repeated identical frames are not
transmitted. Uploaded screenshots are deleted from the collector automatically after the retention
period stated in `config.json`. The images are not analysed, searched, or read by any automated
system.

**A list of browser extensions installed** in Chrome, Brave, Edge and Firefox, including name,
version, source, declared permissions, and whether each is enabled. This is read from the browser's
own preference files. Browsing history, cookies, passwords, session tokens and page contents are
not collected.

**Clipboard metrics.** For each sample: the number of characters copied, a SHA-256 hash of the
content, and a label for what kind of content it was (text, a file list, an image, or nothing).
**The clipboard content itself is never collected.** Hashing happens in a short-lived helper process
on this device, and only the three fields above leave it. There is no field in the agent, in the
upload format, or in the collector's database that can hold clipboard text, and the collector
rejects and logs any upload that attempts to send some.

**Screen state labels** — locked, idle, or active — recorded when a screenshot was skipped.

## How it is transmitted

Events are written to a local spool on this device and uploaded in batches on a schedule. Nothing
is uploaded per keystroke. The batching parameters, the spool size limit, and every interval named
above are set by the collector and are listed in `%PROGRAMDATA%\CTTIme\config.json`. If the
collector is unreachable, nothing about your device's behaviour changes and nothing is lost from
the current spool until it reaches its size limit; if the spool does fill, the oldest events are
discarded and that count is reported to the administrator, so a gap is visible rather than silent.

Traffic is sent only to the collector address in `config.json`, over HTTPS, with the collector's
certificate pinned by fingerprint. The collector may answer on more than one port; a port that does
not present the pinned certificate is refused, and the agent never falls back to plain HTTP.

## Notices shown on your screen

While the agent is running it shows a short pop-up notice on this device's own desktop, in your
signed-in session, when something you would want to know changes:

- the connection to the collector is **lost**, and again when it is **restored**;
- the collector's certificate **cannot be verified**, which means the agent stops collecting until
  it can be;
- this device has been **registered** (awaiting administrator approval), then **approved**, at which
  point collection begins;
- once per day while collecting, a summary of how much has been gathered from this device and how
  long that covers.

The notices carry no screenshot, no clipboard content and no keystroke data — they say only the
status above. They are shown at most once per status per period, so they do not repeat on every
network blip, and the last notices are written to
`%PROGRAMDATA%\CTTIme\pending-shots\notifications.json` where you can read them at any time. If a notice
cannot be displayed, the agent logs that and keeps running; notices are a courtesy to you, not a
control on the collection.

## Your access and recourse

- You can open `%PROGRAMDATA%\CTTIme\config.json` to read exactly what this device is configured to
  collect right now.
- You can read the agent's own log at `%PROGRAMDATA%\CTTIme\agent.log`.
- You can ask the IT administrator when your device was enrolled, who acknowledged on its behalf,
  and what has been retained.
- You can request a copy of the data held about this device, and request its correction or deletion,
  through the process described in the Acceptable Use Policy. The administrator can also revoke this
  device, which stops collection on the next request the agent makes.
- Removing or disabling this software is an administrator action. Attempting to disable it yourself
  is a violation of the Acceptable Use Policy.

## What this notice cannot promise

This notice records that the wording above was presented and that a name was typed beneath it. It
does not, and cannot, establish that the person who typed the name was the device's user, or that
they agreed freely. Those are the employer's obligations, and they are the parts of this arrangement
that the software does not enforce. See `docs/LAWFUL-USE.md`.

<!-- NOTICE-END -->

---

## Acknowledgment

By typing your name below you confirm you have read this notice.

```
Typed name: _______________________
Date:       _______________________
```

An acknowledgment entered without a name, or with a blank or whitespace-only name, is rejected —
both by the collector at enrollment and, independently, by the database when the device is approved.
