# CTTIme — disclosed endpoint monitoring for company Windows devices

Two programs. A **collector** runs on one machine you control: it stores what it receives and serves a dashboard. An **agent** runs on each Windows device you are responsible for: it takes screenshots on a schedule, captures clipboard content, lists browser extensions, and sends it all to the collector. Nothing is watched by surprise — a device sends nothing until the person who uses it has read a plain-English notice and typed their own name, and the collector accepts nothing until an administrator approves that device. Both events are recorded, and the approval trail survives the device being removed.

There is no keylogging, no browsing history, no OCR. Screenshots are stored as pictures and are never analysed. Clipboard content **is** captured (text, copied file paths, images as base64) and sent to the collector — your notice must say so.

This file is the operating manual: install, register, run, review, stop. For the deeper material see [docs/GUIDE.md](docs/GUIDE.md) (troubleshooting), [docs/API-CONTRACT.md](docs/API-CONTRACT.md) (the wire contract) and [docs/PACKAGING.md](docs/PACKAGING.md) (the single-file builds).

**Contents** — [1. Install the collector](#1-install-the-collector) · [2. Install the agent on a device](#2-install-the-agent-on-a-device) · [3. Register a device with the collector](#3-register-a-device-with-the-collector) · [4. Run invisibly (manual install, no window)](#4-run-invisibly-manual-install-no-window) · [5. Set the cadence: 1-min screenshots, 5-min sends](#5-set-the-cadence-1-min-screenshots-5-min-sends) · [6. The dashboard](#6-review-it-on-the-dashboard) · [7. Stop, pause or remove](#7-stop-pause-or-remove)

**What you need**

- **Windows** on every device. Capture, clipboard, token storage and auto-start are Windows-only; there is no macOS or Linux agent.
- **Node.js 22.5 or newer** on the collector, and on a device unless you use `CTTImeSetup.exe`. This project has **no npm runtime dependencies** — no `npm install`, no build step, no compiled add-on. A machine that has never reached the internet runs it.
- **Python 3.10+** only if you deploy the Python client (`client-py/`) — standard library only, same contract, same gates.
- Ports, by default **8443**, reachable from the devices to the collector over TLS. Agents connect outbound only and listen on nothing.

---

## 1. Install the collector

Copy this folder onto the machine that will hold the data and start it. It needs no installation step and no package manager:

```
node server\index.js
```

The first run generates its own TLS certificate and prints everything you need:

```
  listening      https://10.1.2.3:8443
  LAN address    https://10.1.2.3:8443  (Ethernet)
  database       D:\CTime\server\data\collector.db
  screenshots    D:\CTime\server\data\screenshots
  cert SHA-256   01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767
```

Copy that **`cert SHA-256`** value — it is the **pin** every agent is installed with. The certificate is created once and reused on every later start, because regenerating it would break every pinned device.

It binds to `127.0.0.1` by default, so nothing but this machine can reach it. To serve devices, start it bound to the machine's LAN address. Overrides, all optional:

| Variable | Default | Effect |
|---|---|---|
| `CTTIme_BIND` | `127.0.0.1` | Address to listen on. Set the LAN address to serve devices. |
| `CTTIme_PORT` | `8443` | Primary port. |
| `CTTIme_EXTRA_PORTS` | none | Comma-separated extra listeners, e.g. `8444,8445`. |
| `CTTIme_DATA` | `server\data` | Where the database, certificate and screenshots live. |

### Make the first login

There is no default credential anywhere. While the database has no account, the sign-in page is a claim form and the collector prints a one-time code at boot:

```
  first-run code              L23Y5-XA7N6-YBD7Y
  (also in <data dir>\first-run-code.txt)
```

Open `https://<collector-address>:8443/login`, type the code, choose a name and a password. Done — the code deletes itself after the first successful claim.

If the box has no browser reachable from it, the same thing from a shell:

```
node scripts\make-account.js yourname
```

Make one account per person who will look at the dashboard, so the audit log always names a human.

### Keep it running

The collector lives exactly as long as the process that started it. Run it detached so it survives the shell:

```powershell
$env:CTTIme_BIND='10.1.2.3'; $env:CTTIme_PORT='8443'
Start-Process -FilePath node -ArgumentList 'server\index.js' -WorkingDirectory 'D:\CTime' `
  -WindowStyle Hidden `
  -RedirectStandardOutput 'D:\CTime\server\data\collector.out.log' `
  -RedirectStandardError  'D:\CTime\server\data\collector.err.log'
```

Open the firewall for the port, private/LAN profile only:

```
netsh advfirewall firewall add rule name="CTTIme collector" dir=in action=allow protocol=TCP localport=8443
```

To stop it: `taskkill /pid <pid>` where the pid comes from `netstat -ano | findstr :8443`.

---

## 2. Install the agent on a device (manual install)

Installation is manual, per device, from a PowerShell window belonging to the person who uses it. Three routes all end at the same named scheduled task and the same state folder.

### Route A — copy this folder (Python client)

```
cd C:\path\to\CTTIme
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -Client python
```

### Route B — packaged Python executable (no Python needed on the device)

```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> `
  -Client python -AgentExe C:\durable\path\to\CTTImeAgent.exe
```

Put the `.exe` somewhere durable **before** installing — the task points at that path and the installer does not copy it.

### Route C — Node client (default)

```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin>
```

### What install does

- Copies the agent code into `C:\ProgramData\CTTIme\agent-py` (or `agent\` for Node)
- Writes `ABOUT.txt` — what the program is, what it collects, how to stop it
- Registers the scheduled task **`CTTIme Endpoint Visibility`**, visible in Task Scheduler and `schtasks /query`
- The task runs at logon and re-checks every 5 minutes, limited privileges, as that user
- The task action passes `--resident`, which opens **no console window** — invisible on the desktop

> The scheduled task, `config.json`, `agent.log` and `what-collects` are all discoverable by design. The console window is hidden, but nothing about the program itself is hidden. See [docs/LAWFUL-USE.md](docs/LAWFUL-USE.md).

---

## 3. Register a device with the collector

Installing is not registering. A freshly installed agent collects nothing. Four steps, in order:

### 1. The agent fingerprints itself and asks to enroll

It connects with its pin, fetches the notice wording, and waits for an acknowledgment. `check` proves all of this without capturing anything:

```
& "C:\path\to\CTTImeAgent.exe" check --host 10.1.2.3 --pin <pin> --state-dir "C:\ProgramData\CTTIme"
```

### 2. The device user agrees

Two ways — **interactive** (device user types their own name) or **PowerShell-only** (no manual .exe run):

**Interactive (recommended):**
```
& "C:\path\to\CTTImeAgent.exe" run --host 10.1.2.3 --pin <pin> --interactive --state-dir "C:\ProgramData\CTTIme"
```
The notice prints, then it waits for a name. It has to be that device's own user typing it.

**PowerShell-only (no manual .exe):**
```
.\scripts\register-agent.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -AcknowledgeBy "John Doe"
```
Or during install:
```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -Client python -AgentExe C:\durable\CTTImeAgent.exe -AcknowledgeBy "John Doe"
```

The `--acknowledge-by` flag supplies the name non-interactively. The notice text is still printed unless `--no-notice` is passed. Typing `no` writes `DECLINED.txt` and the agent never collects on that device.

### 3. An admin approves

Open `https://<collector>:8443`, go to the dashboard Overview, find the device in the approval queue and click **Approve**. Until you do, the collector rejects everything from it.

### 4. The agent collects its token

On the next pass it receives a bearer token, seals it with DPAPI so only that user can read it, and starts sampling on the server's schedule.

Each step is visible: `status` prints enrollment, whether a token is sealed, the policy in force and how deep the upload queue is.

---

## 4. Run invisibly (manual install, no window)

The agent runs invisibly through the scheduled task: `--resident` hides the console window, and nothing else changes. There is no silent/stealth mode — the task is named, the state folder is discoverable, and the device user sees `ABOUT.txt`.

### Manual install, invisible run

```
# 1. Install (manual, one device at a time)
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -Client python -AgentExe C:\durable\CTTImeAgent.exe

# 2. Acknowledge (device user types their own name)
& "C:\durable\CTTImeAgent.exe" run --host 10.1.2.3 --pin <pin> --interactive --state-dir "C:\ProgramData\CTTIme"

# 3. Approve on the dashboard, then the task runs --resident automatically
```

After approval, the scheduled task launches the agent at logon and every 5 minutes with `--resident`, so no console window ever appears on the user's desktop. The agent keeps running until you disable or delete the task.

### Verify the invisible run

```
schtasks /query /tn "CTTIme Endpoint Visibility" /v /fo LIST
& "C:\path\to\CTTImeAgent.exe" status --state-dir "C:\ProgramData\CTTIme"
& "C:\path\to\CTTImeAgent.exe" what-collects --state-dir "C:\ProgramData\CTTIme"
type "C:\ProgramData\CTTIme\agent.log"
```

### Stop the invisible agent

```
schtasks /end    /tn "CTTIme Endpoint Visibility"
schtasks /change /tn "CTTIme Endpoint Visibility" /disable
```

---

## 5. Set the cadence: 1-min screenshots, 5-min sends

On the collector dashboard → **Policy** page, publish these values. They reach running agents on the next heartbeat — no restart required.

| Key | Value | Bounds | Notes |
|---|---|---|---|
| `screenshot_interval_minutes` | `1` | 1–1440 | A screenshot every 1 minute |
| `heartbeat_interval_seconds` | `300` | 30–3600 | General data (batch + screenshots) sent every 5 min |
| `clipboard_sample_seconds` | `300` | 15–3600 | Clipboard captured every 5 min |
| `clipboard_metrics_enabled` | `true` | — | Clipboard capture on |
| `skip_when_locked` | `true` | — | Skip a locked workstation |
| `idle_skip_seconds` | `600` | 0–86400 | Skip if idle longer than 10 min |
| `dedupe_unchanged_frames` | `true` | — | Skip frames identical to the last one |
| `screenshot_retention_days` | `30` | 1–365 | Age screenshots out on the collector |

Shortening `screenshot_retention_days` deletes files — set it to what your notice promises and no longer.

### Timing summary

- **Clipboard content**: captured every 5 min, sent every 5 min on its own cycle (independent of heartbeat)
- **Screenshots**: captured every 1 min, flushed to the server on each heartbeat cycle (every 5 min)
- **Extension inventory**: once per day by default
- **Heartbeat / policy check**: every 5 min

---

## 6. Review it on the dashboard

Sign in at `https://<collector>:8443`. The Overview answers the one question after an install — **is anything actually arriving, and if not, which step is stuck.**

| Verdict | What it means |
|---|---|
| Waiting for you | Enrolled and acknowledged, sitting in the approval queue |
| Approved, agent has not called in | You approved it; the agent has not collected its token yet |
| Token issued, no request yet | It has the token but nothing authenticated has arrived |
| Talking, but no data accepted yet | Requests are landing; nothing written yet |
| Confirmed working | Data accepted, reporting inside the heartbeat window |
| Silent for *N*m | It stopped reporting — task, pin, machine, in that order |
| Rejected / Revoked | Recorded with the actor, the time and the reason |

| Page | What it is for |
|---|---|
| Overview | Totals, four-step list, approval queue, verdict column |
| Screenshots | Captured frames, newest first, filterable by device |
| Extensions | Browser add-on inventory per device and browser |
| Clipboard | Captured clipboard content (text, file paths, image metadata) per device |
| Telemetry health | Which devices still report, how much they sent, which run an old policy |
| Audit log | Every approval, revocation and policy edit, with actor and time |
| Policy | Capture interval, retention, what is enabled, the notice wording |
| Help | This material, inside the product |

---

## 7. Stop, pause or remove

### Close either one right now

`Ctrl-C` in the window that started it. If detached or windowless, find the process and kill it:

```
netstat -ano | findstr :8443
taskkill /pid <PID>
```

### The agent comes back

Killing the agent's process is temporary: the scheduled task relaunches it within 5 minutes, or at the next logon. To keep a device closed, stop the task:

```
schtasks /end    /tn "CTTIme Endpoint Visibility"
schtasks /change /tn "CTTIme Endpoint Visibility" /disable
```

### Remove it for good

```
powershell -File C:\ProgramData\CTTIme\setup\scripts\uninstall.ps1
```

Revoking the device on the dashboard first records the removal with a reason. Data the collector already received stays until retention ages it out or an admin deletes it.

---

## Verify a build

```
node test\run.js
```

58 acceptance checks cover the consent gate, wire contract, retention, transport pinning, spool, clipboard fields, multi-port failover, pop-ups, and a real screenshot capture.

---

## Read before deploying

[docs/API-CONTRACT.md](docs/API-CONTRACT.md) is the source of truth between agent and collector.  
[docs/NOTICE-TEMPLATE.md](docs/NOTICE-TEMPLATE.md) is the wording users see — update it to say clipboard **content** is captured.  
[docs/PACKAGING.md](docs/PACKAGING.md) covers the single-file builds.  
[docs/LAWFUL-USE.md](docs/LAWFUL-USE.md) separates what this software enforces from what the deployment has to supply.

A signed organisational policy (who is covered, what is collected, why, for how long, who reviews it) must exist before the first device is installed. Nothing here substitutes for it.
