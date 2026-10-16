# CTTIme — disclosed endpoint monitoring for company Windows devices

Two programs. A **collector** runs on one machine you control: it stores what it receives and serves a
dashboard. An **agent** runs on each Windows device you are responsible for: it takes a screenshot on a
schedule, lists browser extensions, and counts clipboard activity. Nothing is watched by surprise —
a device sends nothing until the person who uses it has read a plain-English notice and typed their own
name, and the collector accepts nothing until an administrator approves that device. Both events are
recorded, and the approval trail survives the device being removed.

There is no clipboard text anywhere in this system: not in the wire format, not in the database, not in
a log line. Screenshots are stored as pictures and are never read by OCR or image analysis.

This file is the operating manual: install, register, run, review, stop. For the deeper material see
[docs/GUIDE.md](docs/GUIDE.md) (troubleshooting), [docs/API-CONTRACT.md](docs/API-CONTRACT.md)
(the wire contract) and [docs/PACKAGING.md](docs/PACKAGING.md) (the single-file builds).

**Contents** — [1. Install the collector](#1-install-the-collector) ·
[2. Install the agent](#2-install-the-agent-on-a-device) · [3. Register a device](#3-register-a-device-with-the-collector) ·
[4. Run the agent code](#4-run-the-agent-code-by-hand) · [5. Which process is which](#5-which-process-is-which) ·
[6. The dashboard](#6-review-it-on-the-dashboard) · [7. Stop, pause or remove](#7-stop-pause-or-remove)

**What you need**

- **Windows** on every device. Capture, clipboard, token storage and auto-start are Windows-only; there
  is no macOS or Linux agent.
- **Node.js 22.5 or newer** on the collector, and on a device unless you use `CTTImeSetup.exe`.
  This project has **no npm runtime dependencies** — no `npm install`, no build step, no compiled
  add-on. A machine that has never reached the internet runs it.
- **Python 3.10+** only if you deploy the second client, [client-py/](client-py/README.md) —
  standard library only, same contract, same gates.
- Ports, by default **8443**, reachable from the devices to the collector over TLS. Agents connect
  outbound only and listen on nothing.

---

## 1. Install the collector

Copy this folder onto the machine that will hold the data and start it. It needs no installation step
and no package manager:

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

Copy that **`cert SHA-256`** value — it is the **pin** every agent is installed with. The certificate is
created once and reused on every later start, because regenerating it would break every pinned device.

It binds to `127.0.0.1` by default, so nothing but this machine can reach it. To serve devices, start it
bound to the machine's LAN address. Overrides, all optional:

| Variable | Default | Effect |
|---|---|---|
| `CTTIme_BIND` | `127.0.0.1` | Address to listen on. Set the LAN address to serve devices. |
| `CTTIme_PORT` | `8443` | Primary port. |
| `CTTIme_EXTRA_PORTS` | none | Comma-separated extra listeners, e.g. `8444,8445`. |
| `CTTIme_DATA` | `server\data` | Where the database, certificate and screenshots live. |
| `CTTIme_DB` / `CTTIme_SHOTS` | inside `CTTIme_DATA` | Move one of them only. |

Extra ports are **availability, never identity**: every listener shares the one certificate, so the pin is
unchanged and a pin mismatch never causes a port switch.

### Make the first login

There is no default credential anywhere. While the database has no account, the sign-in page is a claim
form and the collector prints a one-time code at boot:

```
  first-run code              L23Y5-XA7N6-YBD7Y
  (also in <data dir>\first-run-code.txt)
```

Open `https://<collector>:8443/login`, enter the code plus a name and password, and the account exists —
no script, no restart. The code is random, readable only by the account running the collector, and
deleted on the first successful claim; after that the route answers `409 already_claimed` forever. Keep
that first claim to yourself. From a shell instead of a browser:

```
node scripts\make-account.js yourname
node scripts\make-account.js yourname --password-stdin
```

### Keep it running

The collector lives exactly as long as the process that started it. Close the window, end the SSH
session, or pipe its output into something that closes early (`node server\index.js | head`) and it goes
down with it — then every agent logs `network collector unreachable` and looks broken while it is only
waiting. Agents queue their samples on the device and send them when it returns, so downtime is not data
loss, but it is a common false alarm.

```powershell
# a window you leave open
node server\index.js

# detached, logging next to the database, survives the shell that started it
$env:CTTIme_BIND='10.1.2.3'; $env:CTTIme_PORT='8443'
Start-Process -FilePath node -ArgumentList 'server\index.js' -WorkingDirectory 'D:\CTime' `
  -WindowStyle Hidden `
  -RedirectStandardOutput 'D:\CTime\server\data\collector.out.log' `
  -RedirectStandardError  'D:\CTime\server\data\collector.err.log'
```

In `cmd.exe`: `set CTTIme_BIND=10.1.2.3&& start /min node server\index.js`.

Is it answering? `netstat -ano | findstr :8443` should show `LISTENING` on the address you bound. To stop
it, §7.

---

## 2. Install the agent on a device

Three routes. All end in the same place: the same named scheduled task, the same state folder under
`C:\ProgramData\CTTIme`, the same `ABOUT.txt` that explains to the device user what is there.

**A — copy this folder** onto the device, then in a PowerShell window belonging to the person who uses it:

```
cd C:\path\to\CTTIme
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin>
```

**B — hand out one file.** `dist\CTTImeSetup.exe` carries Node and the agent's source inside it, so the
device needs nothing installed:

```
& 'D:\CTime\dist\CTTImeSetup.exe' install --host 10.1.2.3 --pin <pin>
```

**C — the Python client**, from a copy of this folder:

```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -Client python
# or with the packaged agent, which needs no Python on the device:
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> `
  -Client python -AgentExe C:\path\to\CTTImeAgent.exe
```

> **Known breakage on route C.** The package on disk is `client-py/ztakora_agent`, while `install.ps1
> -Client python`, `client-py/__main__.py` and `build-exe.py` still reference `CTTIme_agent`. Until that
> rename is resolved, `-Client python` installs and the `CTTImeAgent.exe` build both fail. Route A or B
> is the working path.

### Parameters

| Parameter | Default | Notes |
|---|---|---|
| `-CollectorHost` | required | Collector address the device reaches. |
| `-Pin` | required | The 64-character `cert SHA-256`. `node scripts\make-cert.js --check` prints it again. |
| `-CollectorPort` | `8443` | Accepts a list: `8443,8444`. Tried in order, and only when a port refuses or times out. |
| `-Client` | `node` | `node` or `python`. |
| `-NodePath` | node on `PATH` | Pass the real binary, not a version manager's shim — the shim's target can change underneath the task. |
| `-PythonPath`, `-PythonSourceDir`, `-AgentExe`, `-SourceDir` | derived | Only for non-default layouts. |
| `-StateDir` | `%PROGRAMDATA%\CTTIme` | Everything the agent owns lives inside this one folder. |
| `-TaskName` | `CTTIme Endpoint Visibility` | Named and visible in Task Scheduler on purpose. |
| `-Acknowledge` | off | Shows the notice now and asks for that user's own name (see §3). |
| `-DryRun` | off | Prints what it would do, changes nothing. Run it first on a fleet. |

### The shell gotchas that cause most failed installs

Every command here is correct; the shell usually refuses it. PowerShell only executes a *quoted* path
when the call operator `&` stands in front of it, and a bare `.\name.exe` is looked up in the window's
own folder.

| What you typed | What you get | Type this |
|---|---|---|
| `.\CTTImeSetup.exe install …` outside `dist` | `The term '.\CTTImeSetup.exe' is not recognized…` | `& 'D:\CTime\dist\CTTImeSetup.exe' install --host … --pin …` |
| `"C:\ProgramData\CTTIme\runtime\node.exe" "…\agent\cli.js" run …` | the same error, because the path is quoted | prefix `&` |
| that Node line on a device installed with `-AgentExe` or `-Client python` | those files do not exist on that route | `& "C:\path\to\CTTImeAgent.exe" run …`, or `python -m CTTIme_agent run …` typed **from inside** `C:\ProgramData\CTTIme\agent-py` |
| any of the above in `cmd.exe` | `&` is wrong there | drop `&`, keep the quotes |

Check where you are and whether the file is really there first: `Get-Location`, then
`Test-Path 'D:\CTime\dist\CTTImeSetup.exe'`.

One placement rule that bites later: with `-AgentExe`, the task points at the exe **where it stands** —
the installer does not copy it into the state folder. Put it somewhere durable before installing, because
moving it breaks the task at the next logon. `ABOUT.txt` and
`schtasks /query /tn "CTTIme Endpoint Visibility" /v /fo LIST` both print the path in use.

### Auto-start

Installing registers a per-user scheduled task that runs at logon and repeats every 5 minutes, with
`IgnoreNew` so the two triggers never stack. It runs limited, as that user, and stores no credential —
there is no service, no driver and no registry run key anywhere. That task is the whole persistence
story, and it is the first thing to look at when a device is quiet.

The task action ends with `--resident`, which opens no console window (see §4). A device installed by an
older `install.ps1` has no `--resident` in its action and still shows a black Node window on the desktop;
reinstall it, or add the flag to that one action.

---

## 3. Register a device with the collector

Installing is not registering. A freshly installed agent is running and enrolled nowhere, and collects
nothing. Four steps have to happen, in this order:

**1. The agent fingerprints itself and asks to enroll.** It connects with its pin, fetches the notice
wording, and waits for an acknowledgment. `check` proves all of this without capturing anything.

**2. The device user agrees.** Their own name, typed by them:

```
node "C:\ProgramData\CTTIme\agent\cli.js" run --host 10.1.2.3 --pin <pin> --interactive
```

The notice prints, then it waits for a name. **It has to be that device's own user typing it** — the name
becomes the consent record, so anyone typing it on their behalf is inventing evidence. Typing `no` writes
`DECLINED.txt` and the agent never collects on that device. The Python client is the same command with
`CTTImeAgent.exe run …` or `python -m CTTIme_agent run …`.

`--acknowledge-by "<name>"` supplies it non-interactively, and `install.ps1 -Acknowledge` does the same
through the notice-and-prompt. Both still print the wording first unless `--no-notice`.

**3. An admin approves.** The device appears in the approval queue on the dashboard Overview. Click
**Approve**. Until you do, the collector rejects everything from it.

**4. The agent collects its token.** On the next pass it receives a bearer token, seals it with DPAPI so
only that user can read it, and starts sampling on the server's schedule.

Each step is visible: `status` prints enrollment, whether a token is sealed, the policy in force and how
deep the upload queue is. A device stuck at step 2 logs `not collecting: consent_required` — that is the
gate working, not a fault, and it is not something to script around.

**Consent is never inherited.** Bumping `notice_version` on the Policy page sends every device back
through step 2. Revoking and re-enabling a device also does.

---

## 4. Run the agent code by hand

Everything below runs against the installed state folder, so the task and a hand-run never fight over
files. On a device installed the normal way the interpreter and script are:

```
C:\ProgramData\CTTIme\runtime\node.exe  C:\ProgramData\CTTIme\agent\cli.js
```

From a copy of this folder, use `node agent\cli.js` instead.

| Command | What it does |
|---|---|
| `check` | Connectivity, pin, notice, enrollment state — then exits. Captures, enrolls and spools nothing, so it disturbs a healthy device zero. **Run this first** when a device misbehaves. Exits non-zero on failure and prints the hash the device was actually offered, which separates "this collector was reinstalled" from "something else is answering on that port". |
| `status` | Local state: enrolled, token sealed, policy in effect, spool depth, notices shown. |
| `what-collects` | The exact collection policy in force and how often it leaves the machine. |
| `one-shot` | Fetch policy, take one of each sample, flush, exit. The fastest way to prove a device end to end. |
| `run` | Enroll if needed, then collect and flush on the server's schedule. Foreground: Ctrl-C stops it. |
| `help` | The option list. |

```
# is this device wired up correctly?
node "C:\ProgramData\CTTIme\agent\cli.js" check --host 10.1.2.3 --pin <pin>

# what does it think it is doing right now?
node "C:\ProgramData\CTTIme\agent\cli.js" status        --state-dir "C:\ProgramData\CTTIme"
node "C:\ProgramData\CTTIme\agent\cli.js" what-collects --state-dir "C:\ProgramData\CTTIme"

# one real round trip, then stop
node "C:\ProgramData\CTTIme\agent\cli.js" one-shot --host 10.1.2.3 --pin <pin>

# run it in this window, watching the log go by
node "C:\ProgramData\CTTIme\agent\cli.js" run --host 10.1.2.3 --pin <pin> --verbose
```

| Option | Effect |
|---|---|
| `--host <addr>` | Required for `run`, `one-shot`, `check`. |
| `--port <n[,n]>` | Default `8443`. Tried in order. |
| `--pin <hex64>` | Required, no fallback, no negotiated downgrade. |
| `--state-dir <dir>` | Override `%PROGRAMDATA%\CTTIme`. Use it to test without touching a real install: `--state-dir D:\CTime\.tmp\agenttest`. |
| `--interactive` | Print the notice and wait for a name on stdin. |
| `--acknowledge-by <name>` | Supply the acknowledgment non-interactively. |
| `--no-notice` | Do not print the wording when acknowledging non-interactively. Prefer not to use it. |
| `--resident` | Scheduled-task mode: opens no console window. Nothing else changes. |
| `--verbose` | Echo the local log to stdout. |

### What `--resident` does and does not do

It calls `ShowWindow(GetConsoleWindow(), SW_HIDE)` and nothing else. The window is a cosmetic artifact of
`node.exe` being a console-subsystem binary — and it titles itself with the command line, which means the
collector's PIN sits in a title bar all day. Only the task passes the flag. A run you type yourself keeps
its window, because hiding it would take over the terminal you are working in.

Every real disclosure surface is untouched and unremovable by design: the named task, `ABOUT.txt`,
plaintext `config.json` and `agent.log`, `what-collects`, the desktop pop-ups, the consent gate. Hiding
the *process* or the *task* is out of scope for this project — see
[docs/LAWFUL-USE.md](docs/LAWFUL-USE.md).

### Pop-ups the device user sees

A short notification in their own session when the agent loses the collector, gets it back, cannot verify
its certificate, registers, is approved, and once a day a count of what has left the machine. No collected
content appears in any of them, each kind repeats at most once per period, and the last twenty are written
to `C:\ProgramData\CTTIme\pending-shots\notifications.json` so `status` can show what the person was and
was not told. A device with no interactive session logs that instead and keeps working — the pop-up is
disclosure, not a gate.

### Reading `agent.log`

Plaintext, and it records refusals too. Most lines are the gate working:

| Line | Meaning | What to do |
|---|---|---|
| `not collecting: consent_required` | Reachable, installed, nobody has agreed | §3 step 2, run by the device user |
| `not collecting: check_failed` | The line above it is the real reason | Read that line |
| `approval check failed: network collector unreachable` | Nothing answers that address and port | `netstat`, then the bind address, then the firewall. Samples queue meanwhile |
| `approval check failed: tls_pin_mismatch` | The certificate offered is not the pinned one | Collector re-certificated, or something else is on that port. Re-read the pin and re-install the device. Trying another port is not a fix |
| `not collecting: declined` + `DECLINED.txt` | The user refused | Recorded and respected |
| `not collecting: revoked` / `rejected` | An admin stopped this device with a reason | Re-enable on the dashboard, which carries no consent over |
| `not collecting: token_issuance_missed` | Approved, but the token never arrived | Rotate the device's token from the dashboard |

`declined`, `rejected`, `revoked` and `token_issuance_missed` are terminal: the agent sits there until a
human changes the state on the device or in the dashboard. A device that stops logging altogether is a
different symptom, and §6's verdict column names it.

---

## 5. Which process is which

The collector and the agent are different programs, and on a test machine they run side by side under the
*same* image name. `Get-Process node` proves nothing on its own: read the command line.

| Role | Process name | Command line ends with | Lives on |
|---|---|---|---|
| **Collector** | `node.exe` | `server\index.js` | the IT box only, always exactly one |
| **Agent** — Node route (default, and what `CTTImeSetup.exe` installs) | `node.exe` | `cli.js run --host … --resident` | each monitored device |
| **Agent** — Python from source | `python.exe` | `-m CTTIme_agent run …` | each monitored device |
| **Agent** — packaged | `CTTImeAgent.exe` | `run … --resident` | each monitored device |
| **Agent children** | `powershell.exe` | `capture.ps1`, `clipboard-probe.ps1`, `notify.ps1` — the Python route also names `clipboard_probe.ps1` and `dpapi_protect.ps1` / `dpapi_unprotect.ps1` | come and go on the schedule |

Three things that look wrong and are not:

- **The collector has no children.** One `node.exe` running `server\index.js` is the whole server. If it
  spawned anything, that is a bug worth reporting.
- **`powershell.exe` appearing and disappearing on a device is the agent working.** Screenshots, clipboard
  metrics, the desktop notice and the DPAPI seal each run as a short probe and never stay resident
  ([QODER.md](QODER.md) requires PowerShell for Windows API access instead of native modules). The Node
  route seals its token with an inline `powershell -Command`, so that child shows a script body in its
  command line rather than a `.ps1` filename.
- **Two `CTTImeAgent.exe` entries are normal** with the packaged route: PyInstaller's `--onefile` starts a
  bootloader parent that unpacks and then runs the real child. Two entries of the *same* `node.exe cli.js
  run` line are **not** normal — that is the scheduled task and a hand-run competing, and `schtasks /query`
  plus `taskkill` on the extra PID settles it.

`--resident` is what separates the task's agent from someone's manual run in that output: only the task
passes it (§4).

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(node|python|CTTImeAgent)\.exe$' -and
                 $_.CommandLine -match 'server[\\/]index\.js|cli\.js|CTTImeAgent|CTTIme_agent' } |
  Select-Object ProcessId, Name,
    @{n='Role';e={ if ($_.CommandLine -match 'server[\\/]index\.js') {'COLLECTOR'}
                   elseif ($_.CommandLine -match '--resident')        {'AGENT (task)'}
                   else {'AGENT (hand-run)'} }},
    CommandLine | Format-Table -Wrap -AutoSize

# the short-lived probes, when you want to see the agent actually working
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'capture\.ps1|clipboard|notify\.ps1|dpapi' } |
  Select-Object ProcessId, CommandLine | Format-Table -Wrap -AutoSize
```

Filtering on `Name` in that first block is not decoration: a bare `CommandLine -match '\.ps1'` also catches
the shell you typed it in and labels it an agent.

---

## 6. Review it on the dashboard

Sign in at `https://<collector>:8443`. The Overview answers the one question that matters after an
install — **is anything actually arriving, and if not, which step is stuck.** It shows how many devices
have cleared each of the four steps, and every device row carries a verdict in that same language, so a
list of "Approved" rows cannot hide an agent that never called in:

| Verdict | What it means |
|---|---|
| Waiting for you | Enrolled and acknowledged, sitting in the approval queue |
| Approved, agent has not called in | You approved it; the agent has not collected its token yet |
| Token issued, no request yet | It has the token but nothing authenticated has arrived — check machine, route, task |
| Talking, but no data accepted yet | Requests are landing; nothing written yet |
| Confirmed working | Data accepted, and reporting inside the heartbeat window |
| Silent for *N*m | It stopped reporting — task, pin, machine, in that order |
| Rejected / Revoked | Recorded with the actor, the time and the reason on the device page |

Open a device and use **Confirm this device** to see the five stamps in order with their times, so a
half-installed fleet becomes a list of named gaps instead of a mystery.

| Page | Path | What it is for |
|---|---|---|
| Overview | `/` | Totals, the four-step list, the approval queue, the verdict column |
| Screenshots | `/screenshots` | Captured frames, newest first, filterable by device |
| Extensions | `/extensions` | Browser add-on inventory per device and browser |
| Clipboard | `/clipboard` | Counts, sizes and a coarse content label. There is no text column to look at |
| Telemetry health | `/health` | Which devices still report, how much they sent, which run an old policy |
| Audit log | `/audit` | Every approval, revocation and policy edit, with actor and time |
| Policy | `/policy` | Capture interval, retention, what is enabled, the notice wording |
| Help | `/help` | This material, inside the product |

Policy changes are validated against bounds before they are written and reach running agents on the next
heartbeat without a restart. Retention ages screenshots out on its own; the export controls are the only
way to bulk-remove them.

---

## 7. Stop, pause or remove

### Close either one right now

`Ctrl-C` in the window that started it is the whole manual stop, for the collector and for the agent. If it
is running detached or with no window, find the process and kill it:

```
netstat -ano | findstr :8443
taskkill /pid <PID>
```

```powershell
# the collector, by port
Get-NetTCPConnection -LocalPort 8443 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# both programs, when they share the name node.exe: read the command line before killing
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
```

`server\index.js` is the collector, `cli.js run` is an agent. The collector has no task, no service and no
watchdog, so once it is stopped it stays stopped until you start it again.

### The agent comes back

Killing the agent's process is temporary: the scheduled task relaunches it within 5 minutes, or at the next
logon. To keep a device closed, stop the task too:

```
schtasks /end    /tn "CTTIme Endpoint Visibility"
schtasks /change /tn "CTTIme Endpoint Visibility" /disable
```

`/disable` is the one to use day to day. The install, the consent record, the log and the sealed token all
stay on disk, and `/enable` puts the device back on the schedule. `/delete` removes the persistence
permanently but still leaves `C:\ProgramData\CTTIme` and its token in place.

| Want | Use |
|---|---|
| Stop for an hour, keep everything | `Ctrl-C`, or `schtasks /end` |
| Closed until you re-enable it | `schtasks /change … /disable` |
| Stop the process only | `taskkill /pid <PID>` (the task restarts it) |
| Remove it, keep evidence | `uninstall.ps1 -KeepData` |
| Remove the device cleanly | revoke on the dashboard, then `uninstall.ps1` |

### Remove it for good

```
powershell -File C:\ProgramData\CTTIme\setup\scripts\uninstall.ps1 -DryRun
powershell -File C:\ProgramData\CTTIme\setup\scripts\uninstall.ps1
```

(Installed by copying the folder? `uninstall.ps1` is in that copy's `scripts` folder. `ABOUT.txt` prints the
right path for the way your device was installed.)

It stops and unregisters the task, then deletes the state folder: code, config, log, queue and sealed
token. `-KeepData` leaves logs and queue for an audit. Data the collector already received stays there
until retention ages it out or an admin deletes it, so **revoke the device on the dashboard first** — that
records the removal with a reason. The device row and its consent record are kept on purpose.

---

## Verify a build

```
node test\run.js
```

58 acceptance checks: the consent gate, the wire contract, retention, transport pinning, the spool, the
clipboard's absence of content, multi-port failover, the pop-ups shown to the device user, and a real
screenshot capture on the machine running them.

```
node scripts\perf-bench.js
```

Boots a throwaway collector on a loopback port in `.tmp\perf`, drives the heartbeat, batch and screenshot
routes as agents would, and fails if any event it sent is unaccounted for. Measured figures are in
[docs/README.md](docs/README.md).

## Not in this version

- No macOS or Linux agent, and no way to build one from a Windows machine.
- No roles or read-only logins: every dashboard account is a full administrator.
- No central management of the collector's certificate beyond
  `node scripts\make-cert.js --rotate`, which invalidates every pin and means re-installing each device.
- No alerting, no bulk screenshot export, no reporting.
- No smart-card or SSO login; passwords only, hashed with scrypt.

## Read before deploying

[docs/API-CONTRACT.md](docs/API-CONTRACT.md) is the source of truth between agent and collector.
[docs/NOTICE-TEMPLATE.md](docs/NOTICE-TEMPLATE.md) is the wording users see.
[docs/PACKAGING.md](docs/PACKAGING.md) covers the single-file builds and their limits.
[docs/LAWFUL-USE.md](docs/LAWFUL-USE.md) separates what this software enforces from what the deployment
has to supply. [QODER.md](QODER.md) states the ground rules no change here may break.

A consent record is not the same thing as consent. The database can prove that a name was typed at a
notice on a date; it cannot prove the person understood it, was not rushed, or was the actual device user.
The policy that authorises this deployment — who is covered, for what purpose, for how long, and who
reviews it — is a document you have to write and sign separately. Nothing here substitutes for it.
