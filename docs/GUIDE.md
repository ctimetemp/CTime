# The plain-words guide — install it, build it, use it

This is the hands-on document. It tells you what to type, in what order, and what you should see back.
It does not argue design decisions — those are in [README.md](../README.md), the wire rules are in
[API-CONTRACT.md](API-CONTRACT.md), and the legal boundary is in [LAWFUL-USE.md](LAWFUL-USE.md).

Three parts: **[1. Install](#part-1--install)** · **[2. Build](#part-2--build)** ·
**[3. Use](#part-3--use)**, then [When something is wrong](#when-something-is-wrong) and
[Words used here](#words-used-here).

Before you start, one thing is not optional: this product only becomes lawful under a written policy
your organisation has signed — who is covered, what is collected, why, for how long, and who can look.
Read [LAWFUL-USE.md](LAWFUL-USE.md) and have that document exist before the first device is installed.

---

## The whole picture in one minute

| Piece | What it is | Where it runs |
|---|---|---|
| **Collector** | One program. Stores what it receives and shows the dashboard. | One machine you choose — a server, a workstation, a VM |
| **Agent** | A small program that takes a screenshot on a schedule, lists browser extensions, counts clipboard activity | Each Windows device you are responsible for |

Nothing else. No database server, no message queue, no npm packages, no cloud account.

Data only moves when the agent asks for it. An agent connects out to the collector; the collector never
connects to a device, and an agent listens on no port at all.

Four steps have to happen before a device produces anything, and every screen in this product uses the
same four words:

```
1  the agent enrolls  →  2  the device user acknowledges the notice  →
3  an admin approves  →  4  the round trip confirms data actually arrived
```

Step 2 cannot be done for someone else. Typing another person's name creates a consent record that is
not true, and the audit log will show it.

---

## Part 1 — Install

### 1.1 Pick a route for the device

| Route | What you hand out | What must already be on the device | The agent process is named |
|---|---|---|---|
| **A — copy the folder** | This whole project folder | Node.js | `node.exe` |
| **B — one file, Node inside** | `dist\CTTImeSetup.exe` (≈137 MB) | nothing | `node.exe` (the runtime inside it) |
| **C — one file, Python inside** | `dist\CTTImeAgent.exe` (≈8.9 MB) | nothing | `CTTImeAgent.exe` |

Pick **C** when you want a small file and a process name that matches the product. Pick **B** when you
want the Node client. Pick **A** when the device already has this repo checked out.

The scheduled task is named `CTTIme Endpoint Visibility` on every route, and it is visible in Task
Scheduler and in `schtasks /query`. There is no flag anywhere that hides any part of the install.

### 1.2 Start the collector

Copy the project to the machine that will hold the data, then run it with Node 22.5 or newer:

```
node server\index.js
```

The first start creates its own certificate and prints what you need:

```
  listening      https://10.1.2.3:8443
  LAN address    https://10.1.2.3:8443  (Ethernet)
  database       D:\CTTIme\server\data\collector.db
  cert SHA-256   01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767
  first-run code L23Y5-XA7N6-YBD7Y
```

**Write down the `cert SHA-256` value.** That is the **pin**, and every device gets it at install time.
You can read it again any time:

```
node scripts\make-cert.js --check
type server\data\tls\fingerprint.txt
```

By default the collector answers only on `127.0.0.1`, so devices cannot reach it yet. Tell it which
address to serve on:

```
set CTTIme_BIND=10.1.2.3
node server\index.js
```

| Setting | Default | Use |
|---|---|---|
| `CTTIme_BIND` | `127.0.0.1` | The LAN address devices can reach. Never use `0.0.0.0` on a machine whose only network card has a public address — name the address you want exposed |
| `CTTIme_PORT` | `8443` | The main port |
| `CTTIme_EXTRA_PORTS` | none | e.g. `8444,8445`. Each one serves the identical thing with the same certificate, so a device blocked on one port tries the next. The pin does not change |
| `CTTIme_DATA` | `server\data` | Where the database, certificates and screenshot files live |

Keep it running with whatever you use for other long-running programs. If it stops, nothing is lost:
agents keep collecting to their own local queue and send it when the collector returns.

To start it detached, so it stays up after you close the window (logs land next to the database):

```
$env:CTTIme_BIND='10.1.2.3'; $env:CTTIme_PORT='8443'
Start-Process -FilePath node -ArgumentList 'server\index.js' -WorkingDirectory 'D:\CTTIme' `
  -WindowStyle Hidden `
  -RedirectStandardOutput 'D:\CTTIme\server\data\collector.out.log' `
  -RedirectStandardError  'D:\CTTIme\server\data\collector.err.log'
```

It is the collector's own process, so stop it with `taskkill /pid <pid>` once you have found that pid in
`netstat -ano | findstr :8443`. Do not pipe a running server's output through a limiter like `head` — when
the pipe closes, the server is taken down with it.

Open the machine's firewall for the port, for the private/LAN profile only:

```
netsh advfirewall firewall add rule name="CTTIme collector" dir=in action=allow protocol=TCP localport=8443
```

### 1.3 Make the first login

There is no default password anywhere. While the database has no account, the sign-in page is a claim
form and the collector prints a one-time code (also in `server\data\first-run-code.txt`).

Open `https://<collector-address>:8443/login`, type the code, choose a name and a password. Done — the
code deletes itself after the first successful claim.

If the box has no browser reachable from it, the same thing from a shell:

```
node scripts\make-account.js yourname
```

Make one account per person who will look at the dashboard, so the audit log always names a human.

### 1.4 Put an agent on a device

Run this on the device, in a PowerShell window belonging to the person who uses it. It needs the
collector's address and the pin from step 1.2:

```
# Route C — the small file, nothing to install on the device
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 `
  -Pin 01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767 `
  -Client python -AgentExe C:\path\to\CTTImeAgent.exe

# Route B — one file that carries Node inside it
CTTImeSetup.exe install --host 10.1.2.3 --pin <pin>

# Route A — from a copy of this folder
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin>
```

Add `-CollectorPort 8443,8444` when the collector listens on more than one port. If Node is not on
`PATH`, pass `-NodePath C:\path\to\node.exe` — and prefer a real binary over a version manager's shim.

To see what it would do without touching anything, add `-DryRun`. (One caveat: `-DryRun` stops the
*installer* step from writing, but the setup exe still drops its own files into the state folder first.)

**If PowerShell says `The term '.\CTTImeSetup.exe' is not recognized`**, the window is not in the folder
that holds the file — `.\name` is looked up in PowerShell's own current directory. Use the absolute path,
and keep the `&`, because PowerShell only runs a quoted path when the call operator precedes it:

```powershell
& 'D:\CTTIme\dist\CTTImeSetup.exe' install --host 10.1.2.3 --pin <pin>
Get-Location        # where am I?
Test-Path 'D:\CTTIme\dist\CTTImeSetup.exe'    # is the file where I think it is?
```

The same rule applies to every later command in this guide. In `cmd.exe`, drop the `&` and just quote
the path.

At this point the agent is installed and scheduled, and it collects **nothing**. It waits.

### 1.5 The agreement step — the device user does this

```
CTTImeAgent.exe run --host 10.1.2.3 --pin <pin> --interactive
```

(Node client: `& "C:\ProgramData\CTTIme\runtime\node.exe" "C:\ProgramData\CTTIme\agent\cli.js" run
--host 10.1.2.3 --pin <pin> --interactive`. Python from source: `python -m CTTIme_agent run …`, from
`C:\ProgramData\CTTIme\agent-py`.)

On the packaged-Python route there is no `runtime\node.exe` and no `agent\cli.js` — use the exe:
`& "C:\path\to\CTTImeAgent.exe" run --host … --pin … --interactive`. Put that file somewhere durable
**before** you install with it: the scheduled task points at the path you passed and the installer does not
copy the exe into the state folder, so deleting it out of `Downloads` stops the device at the next logon.
`C:\ProgramData\CTTIme\ABOUT.txt` prints the path the task is actually running.

The full notice prints on screen and it asks for a name. The person types their own name, or types
`no` — which writes `DECLINED.txt`, records the refusal, and that device never collects.

Do not add `--acknowledge` / `-Acknowledge` to install the device for someone. That flag exists for the
case where the user is standing there and you are typing what they said; the operator's own name goes
into the record, not theirs.

### 1.6 Approve, then confirm

The device now sits in the approval queue on the dashboard. Open it and click **Approve**. Until you
do, the collector refuses everything from it.

Then check that it is really talking: the device row carries a verdict — **Waiting for you → Approved,
agent has not called in → Token issued → Talking → Confirmed working.** Open the device and use
**Confirm this device** to see the five stamps with their times.

### 1.7 Install checklist

- [ ] The collector is bound to an address devices can reach, and the firewall allows that port
- [ ] You have one dashboard account per human, no shared login
- [ ] The signed policy document exists before the first device enrolled
- [ ] Everyone covered was told in general, before installation, not at the notice screen
- [ ] Each acknowledgment was typed by that device's own user
- [ ] `screenshot_retention_days` on the Policy page matches what the notice promises

---

## Part 2 — Build

You only need this section if you are changing code or producing your own executables. Nobody installing
a device builds anything.

| Build | Command on | Needs | Produces |
|---|---|---|---|
| Python agent | Windows, Python 3.10+, `pip install pyinstaller` | build-time only | `dist\CTTImeAgent.exe` — about 14 seconds, ≈8.9 MB |
| Node setup file | Windows, Node 22.5+ | build-time only | `dist\CTTImeSetup.exe` — ≈137 MB |

```
python client-py\build-exe.py
node scripts\build-agent-exe.js
```

Options: `--out <dir>`, `--name <file>`, `--runtime <path to node.exe>`, `--keep`, and `--onedir` for the
Python build (a folder instead of one file — starts faster, unpacks nothing to `%TEMP%`).

PyInstaller is a build tool only. The shipped client imports nothing outside the standard library, so the
zero-dependency rule still holds on the device.

### Check what you built

Both builds write a checksum and a file manifest next to the exe:

```
certutil -hashfile dist\CTTImeAgent.exe SHA256
type dist\CTTImeAgent.exe.sha256
type dist\PACKAGED-FILES-PYTHON.txt
```

Then prove it runs, without installing anything, using a throwaway state folder:

```
dist\CTTImeAgent.exe check --host 127.0.0.1 --port 8443 --pin <pin> --state-dir C:\temp\zt-check
dist\CTTImeSetup.exe unpack --state-dir C:\temp\zt-unpack
```

`unpack` writes the bundled runtime and the readable agent source so you can open it and compare. Every
`.py` and `.ps1` ships as plain text inside the exe for the same reason.

### Rules about building

- **Windows only.** There is no macOS or Linux agent, and no way to cross-build one from this machine.
- **Sign it, or expect SmartScreen.** Do not train anyone to click through a warning. Either use a
  code-signing certificate or install from the readable folder route (route A) and leave the exe out.
- **Give your security team the file list before the first alert**, not after: `PACKAGED-FILES.txt`,
  `PACKAGED-FILES-PYTHON.txt`, the launcher source, and the task name. An unsigned PyInstaller binary
  that unpacks itself to `%TEMP%` looks exactly like what an EDR console is watching for — because that
  is how PyInstaller works, not because anything here is hidden.
- Rebuild after any change to `agent/` or `client-py/`, then re-run the `check` above. The harness passing
  proves the source works; running the exe proves the exe carries it.

### Verify the whole project

```
node test\run.js
```

58 acceptance checks: the consent gate, the wire contract, retention, transport pinning, the local spool,
the clipboard's total absence of content, multi-port failover, the connection pop-ups, and a real
screenshot capture on the machine running them. To see what one collector box can take:
`node scripts\perf-bench.js`.

---

## Part 3 — Use

### 3.1 The daily look

Open the Overview. It answers the only question that matters: **is anything arriving, and if not, which
step is stuck.**

| Verdict | What it means | What you do |
|---|---|---|
| Waiting for you | Enrolled and acknowledged, in the queue | Approve it, or record why not |
| Approved, agent has not called in | You approved; the agent hasn't come back | Check the device is on and can reach the port |
| Token issued, no request yet | It has a token, nothing authenticated has landed | `check` on the device, look at `agent.log` |
| Talking, but no data accepted yet | Requests arriving, nothing written yet | Usually clears within a cycle; check the policy switches |
| Confirmed working | Data accepted, reporting inside the heartbeat window | Nothing |
| Silent for *N*m | It stopped reporting | Check the task, the pin, the machine |
| Rejected / Revoked | Recorded with actor, time and reason | Nothing, unless it was a mistake |

Other pages: **Screenshots** (frames, newest first), **Extensions** (add-on inventory), **Clipboard**
(counts, sizes, a coarse label — there is no text column to look at), **Telemetry health** (who is
reporting, how much, who runs an old policy), **Audit log** (every action, with actor and IP), **Policy**,
**Help**.

### 3.2 Change what is collected

Policy page: capture interval, retention days, which collectors are enabled. Values are checked against
bounds before they are written, and reach running agents on their next heartbeat — no device restart.

Two warnings:

- **Shortening `screenshot_retention_days` deletes files.** An hourly sweep removes frames older than the
  number on the page, files before rows. Set it to what the notice promises and no longer.
- **Publishing a new notice version returns every device to pending.** Each device user has to acknowledge
  again, in their own window. Editing the wording *at the same version* is a typo fix and keeps consent.
  Never publish a bump as a way to make a device re-accept something you changed behind someone's back.

### 3.3 When a device user asks to see or delete their data

1. **Copy** — the device page's *Export all data (JSON)* gives them their events, screenshot metadata and
   extension rows. This is audited as `data_export`.
2. **Stop** — revoke the device with a reason. Collection stops on that agent's next request.
3. **Remove** — shorten retention and let the sweep age it out, or delete rows and files while the
   collector is stopped. Keep the device row and its consent record: the fact that someone agreed and
   later withdrew is the evidence that makes the rest of this credible.

`what-collects` on the device prints the same disclosure without needing the network:

```
CTTImeAgent.exe what-collects
CTTImeAgent.exe status
type C:\ProgramData\CTTIme\agent.log
type C:\ProgramData\CTTIme\pending-shots\notifications.json
```

### 3.4 What the device user sees while it runs

A short pop-up in their own session when: the device is registered, it is approved and collection begins,
the collector becomes unreachable, it comes back, the collector's certificate cannot be verified, and once
a day a count of what left the machine. No collected content is in any of those messages, each kind repeats
at most once per period, and the last twenty attempts are recorded in
`C:\ProgramData\CTTIme\pending-shots\notifications.json`. A device with no interactive session logs it
instead and keeps working — the pop-up is disclosure, not a control.

### 3.5 Remove it

```
powershell -File C:\ProgramData\CTTIme\setup\scripts\uninstall.ps1
```

(If you installed by copying the folder, `uninstall.ps1` is in that copy's `scripts` folder. `ABOUT.txt`
in the state folder prints the right path for the way your device was installed.) Add `-KeepData` to leave
the log and queue in place for an audit. Revoke the device on the dashboard as well, so the removal has a
recorded reason next to a name.

### 3.6 Never, in one list

- Never acknowledge, or approve, on someone's behalf.
- Never monitor a device that the company does not manage.
- Never deploy without the notice, and never treat "they signed at hire" as the notice.
- Never use it to watch someone secretly — it is visible by construction and the trail shows it.
- Never ask for clipboard text, keylogging, browsing history or OCR. There is no column and no code path
  for any of them, and that is permanent, not a backlog.
- Never keep data past the retention you told people about.
- Never share a dashboard account.

---

## When something is wrong

Run this first, on the device. It changes nothing and tells you exactly which step failed:

```
CTTImeAgent.exe check --host 10.1.2.3 --port 8443 --pin <pin>
```

| Symptom | Most likely cause | What to do |
|---|---|---|
| `The term '.\CTTImeSetup.exe' is not recognized…` | PowerShell is in a different folder, or the quoted path is missing its `&` call operator | `& 'D:\CTTIme\dist\CTTImeSetup.exe' install …`, after `Test-Path 'D:\CTTIme\dist\CTTImeSetup.exe'` says `True` |
| The device stopped running after a reboot, and it used `CTTImeAgent.exe` | Someone moved or deleted the exe — the task points at the path you installed from, it is not copied into the state folder | Put the file back where it was, or re-install pointing at a durable path; `C:\ProgramData\CTTIme\ABOUT.txt` names the path the task expects |
| The collector was running, then it was not | Its shell session ended, or its output was piped into something that closed (`… \| head`) | Start it detached with the `Start-Process` block in [1.2](#12-start-the-collector); check with `netstat -ano \| findstr :8443` |
| `check` says the pin does not match | The collector was reinstalled or re-certificated, or something else is answering that port | Get the new value from `make-cert.js --check`, re-install the device with it. Do not "try the other port" — a mismatch is terminal by design |
| `check` connects on no port | Firewall, wrong address, collector bound to `127.0.0.1` | On the collector: `set CTTIme_BIND=<LAN address>` and restart. Test with `Test-NetConnection 10.1.2.3 -Port 8443` |
| Device is *Approved, agent has not called in* | The task never ran, or it ran without an acknowledgment | `schtasks /query /tn "CTTIme Endpoint Visibility" /v /fo LIST`, then `type C:\ProgramData\CTTIme\agent.log` |
| Device is *Silent for N m* | Machine off, agent uninstalled, or the collector stopped | Check the collector is running, then the task, then the log |
| Nothing appears on the Screenshots page | Interval policy long, screen locked or idle, or the device is declined/pending | Look at `status` on the device — it prints the policy actually in force and the spool depth |
| Spool keeps growing | The collector is unreachable or the route is refusing the batch | `CTTImeAgent.exe status`; then the collector's own console. Oldest items are evicted at the cap and the drop count is reported, not hidden |
| "consent_required" in the log, and it stays | Nobody has acknowledged on that device yet — this is correct behaviour | Have the device user run step 1.5 |
| A balloon did not appear | No interactive session, or the same kind was shown inside its throttle window | `type C:\ProgramData\CTTIme\pending-shots\notifications.json` shows what was sent and what failed |
| `npm install` / `pip install` feels necessary | It isn't | The collector has zero runtime npm dependencies; the Python client is standard library only |

Every line the agent writes to `agent.log`, and the four reasons it stops permanently until a human acts,
are listed in [Reading the agent's own lines](../README.md#reading-the-agents-own-lines).

---

## Words used here

| Word | Plain meaning |
|---|---|
| **Pin** | The 64-character fingerprint of the collector's certificate. The agent refuses any server that does not present exactly it |
| **Notice** | The plain-English page the device user reads and agrees to. Its text and version live on the Policy page |
| **Acknowledgment** | The device user's own typed name against that notice, on a date. It is what unlocks approval |
| **Approval** | The admin's decision that this device may send data. Separate from consent, and both are required |
| **Spool** | The agent's local queue on the device. What it fills while the collector is away |
| **Round trip** | The proof chain: enrolled → acknowledged → approved → data actually accepted |
| **Retention** | How many days the collector keeps screenshot files before the hourly sweep deletes them |
| **Verdict** | The one-word status on a device row, in the four-step language above |

---

*Next reads:* [API-CONTRACT.md](API-CONTRACT.md) for the wire, [NOTICE-TEMPLATE.md](NOTICE-TEMPLATE.md)
for what users are told, [PACKAGING.md](PACKAGING.md) for the executables, [LAWFUL-USE.md](LAWFUL-USE.md)
for the boundary between the software and the deployment.
