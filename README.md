# CTTIme — disclosed endpoint monitoring for company Windows devices

CTTIme has two parts. A **collector** is one program on one machine: it stores what it receives and
shows you a dashboard. An **agent** is a small program on each Windows device you are responsible for:
it takes a screenshot on a schedule, lists browser extensions, and counts clipboard activity. Two
agents ship, and a device runs one or the other: `agent/` (Node) and [client-py/](client-py/README.md)
(Python, standard library only). They speak the same contract and enforce the same gates.

The point of the design is that nobody is watched by surprise. A device sends nothing until the person
who uses it has read a plain-English notice and typed their own name to agree, and nothing is accepted
until an administrator approves that device. Both events are recorded, and the approval trail survives
the device being removed.

There is no clipboard text anywhere in this system: not in the wire format, not in the database, not in
a log line. Screenshots are stored as pictures and are never read by OCR or image analysis.

**If you are here to install it, build it or run it, go to [docs/GUIDE.md](docs/GUIDE.md)** — plain
words, every command, and a troubleshooting table. This file is the overview.

## What you need

- **Windows** for the agents. The agent's screen capture, clipboard reading, token storage and
  auto-start are written for Windows; there is no macOS or Linux implementation yet
  (see [docs/PACKAGING.md](docs/PACKAGING.md)).
- **Node.js** for the collector, and for the agent unless you use the single-file setup below.
  Node 22.5 or newer. Nothing else: this project has **no npm runtime dependencies**, so there is no
  `npm install`, no build step and no compiled add-on. A machine that has never reached the internet
  runs it fine.
- **Python 3.10 or newer** instead, if you deploy `client-py/` and run it from source — it is standard
  library only. `dist\CTTImeAgent.exe` needs nothing at all on the device. See
  [docs/PACKAGING.md](docs/PACKAGING.md).
- One or more TCP ports, by default **8443**, reachable from the devices to the collector. They carry
  the dashboard and the agents' uploads over TLS. Agents make outbound connections only and listen on
  nothing. Extra listeners are optional: set `CTTIme_EXTRA_PORTS=8444,8445` (or `extra_ports` in the
  server config file) and the collector serves the identical thing on each, so a device that cannot
  reach one port tries the others in order. Every listener shares one certificate, so **the pin is
  unchanged** and a pin mismatch never causes a port switch.

## Run the collector

Copy this folder onto the machine that will hold the data, then:

```
node server\index.js
```

On the first run it creates its own certificate and prints everything you need:

```
  listening      https://10.1.2.3:8443
  LAN address    https://10.1.2.3:8443  (Ethernet)
  database       D:\CTTIme\server\data\collector.db
  cert SHA-256   01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767
```

That `cert SHA-256` value is the **pin**. Each device is given it at install time and will refuse to
talk to anything that does not present exactly that certificate — there is no plaintext fallback and no
downgrade. The certificate is created once and reused on every later start, because regenerating it
would break every pinned device.

Make the first login. There is no default credential anywhere: while the database has no account, the
sign-in page is a claim form instead, and the collector prints a one-time code at boot to go with it:

```
  first-run code              L23Y5-XA7N6-YBD7Y
  (also in <data dir>\first-run-code.txt)
```

Open `https://<collector>:8443/login` in a browser, type the code and the name and password you want,
and that is the account created — no script, no restart. The code is random, readable only by the
account running the collector (mode `0600`), and deleted on the first successful claim; after that the
route answers `409 already_claimed` forever. If the browser is not reachable from the collector box,
the same thing from a shell:

```
node scripts\make-account.js yourname
```

Either way, keep that first claim to yourself: whoever holds the code holds the first administrator
account. Logins are refused until an account exists.

Then open the dashboard address in a browser and sign in. Overrides, all optional:
`CTTIme_BIND` (default `127.0.0.1`, so it is reachable only from this machine until you say
otherwise — set it to the machine's LAN address to serve devices),
`CTTIme_PORT`, `CTTIme_DATA` (where the database, certificates and screenshots live).

Keep it running with whatever you use for other long-running programs. If it stops, agents queue their
samples on the device and send them when it returns.

Collector downtime is never data loss, but it is a common false alarm: the collector lives exactly as long
as the process that started it. Close the window, end the SSH session, or pipe its output into something
that closes early (`node server\index.js | head`) and the server goes down with it — then every agent logs
`network collector unreachable` and looks broken while it is only waiting. Two ways to keep it up:

```powershell
# a window you leave open
node server\index.js

# detached, logging next to the database, survives the shell that started it
$env:CTTIme_BIND='10.1.2.3'; $env:CTTIme_PORT='8443'
Start-Process -FilePath node -ArgumentList 'server\index.js' -WorkingDirectory 'D:\CTTIme' `
  -WindowStyle Hidden `
  -RedirectStandardOutput 'D:\CTTIme\server\data\collector.out.log' `
  -RedirectStandardError  'D:\CTTIme\server\data\collector.err.log'
```

In `cmd.exe` the same detached start is `set CTTIme_BIND=10.1.2.3&& start /min node server\index.js`.

Is it answering? `netstat -ano | findstr :8443` should show `LISTENING` on the address you bound, and
`CTTImeAgent.exe check --host <that address> --port 8443 --pin <pin>` should print
`"pin_verified": true`. To stop it, `taskkill /pid <that pid>`.

## Put an agent on a device

Three ways. All of them end up in the same place, with the same installer, the same named scheduled
task and the same `ABOUT.txt`.

**A. Copy the folder** onto the device and, in a PowerShell window belonging to the person who uses it:

```
cd C:\path\to\CTTIme
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin>
```

**B. Hand out one file.** `CTTImeSetup.exe` carries Node and the agent's source inside it, so the
device needs nothing installed:

```
CTTImeSetup.exe install --host 10.1.2.3 --pin <pin>
```

**C. Run the Python client.** From a copy of this folder, with Python on the device:

```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> -Client python
```

or with the packaged agent, which needs no Python installed:

```
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CollectorHost 10.1.2.3 -Pin <pin> `
  -Client python -AgentExe C:\path\to\CTTImeAgent.exe
```

`-Client python` copies the readable sources to `C:\ProgramData\CTTIme\agent-py` and schedules
`python -m CTTIme_agent run …` (or the exe) with the same arguments, same task name and same state
files.

`-CollectorPort` takes a list as well: `-CollectorPort 8443,8444` gives the device the same port set the
collector listens on, and `--port 8443,8444` does the same when you run the client by hand. The device
tries them in order and moves to the next one only when a port refuses the connection or times out.

### Typing these commands on a device

Every command in this file is correct; most failed installs are the shell refusing to run it. PowerShell
only executes a quoted path when the call operator `&` stands in front of it, and a bare
`.\name.exe` is looked up in the window's *own* folder.

| What you typed | What you get | What to type |
|---|---|---|
| `.\CTTImeSetup.exe install …` in a window that is not sitting in `dist` | `The term '.\CTTImeSetup.exe' is not recognized…` | `& 'D:\CTTIme\dist\CTTImeSetup.exe' install --host … --pin …` |
| `"C:\ProgramData\CTTIme\runtime\node.exe" "C:\ProgramData\CTTIme\agent\cli.js" run …` | the same not-recognized error, because the path is quoted | `& "C:\ProgramData\CTTIme\runtime\node.exe" "C:\ProgramData\CTTIme\agent\cli.js" run …` |
| that Node line, on a device installed with `-AgentExe` or `-Client python` | `runtime\node.exe` and `agent\cli.js` do not exist on that route | `& "C:\path\to\CTTImeAgent.exe" run …` for the packaged Python client, or `python -m CTTIme_agent run …` typed **from inside** `C:\ProgramData\CTTIme\agent-py` (the `-m` form finds the package through the working directory) for the source route |
| any of the above in `cmd.exe` | works, but the `&` is wrong there | drop `&` and just quote the path: `"D:\CTTIme\dist\CTTImeSetup.exe" install --host …` |

Check where you actually are and whether the file is really there before anything else:

```
Get-Location
Test-Path 'D:\CTTIme\dist\CTTImeSetup.exe'
```

One placement rule that bites later: when you install with `-AgentExe`, the scheduled task points at the
exe **where it stands** — the installer does not copy it into the state folder. Put it somewhere that
survives (a share, `C:\ProgramData\CTTIme\`, a tools directory) before installing, because moving or
deleting it breaks the task at the next logon. `C:\ProgramData\CTTIme\ABOUT.txt` prints the exact path
the task is using, and so does `schtasks /query /tn "CTTIme Endpoint Visibility" /v /fo LIST`.

### What the device user sees while it runs

The agent shows a short pop-up in that user's own session when: it loses the collector, gets it back,
cannot verify the collector's certificate, is registered, is approved, and once a day a count of what
has left the machine. No collected content is in any of those messages, they repeat at most once per
kind per period, and the last twenty are written to `C:\ProgramData\CTTIme\pending-shots\notifications.json`
so `status` can show what the person was and was not told. A device that cannot display a balloon (no
interactive session) logs that instead and keeps working — the pop-up is disclosure, not a gate.

Whichever route you used, add `--acknowledge` / `-Acknowledge` to show the notice right now and capture
that person's agreement. Without it the agent is installed and running but enrolled nowhere, and
collects nothing until they run it themselves and agrees.

If Node is not on `PATH`, pass `-NodePath C:\path\to\node.exe`. Prefer the real binary over a version
manager's launcher shim: the shim's target can change underneath the scheduled task.

### The agreement step

```
node "C:\ProgramData\CTTIme\agent\cli.js" run --host 10.1.2.3 --pin <pin> --interactive
```

(For the Python client: `python -m CTTIme_agent run --host 10.1.2.3 --pin <pin> --interactive`, run
from `C:\ProgramData\CTTIme\agent-py`, or `CTTImeAgent.exe run …` if you installed the exe.)

This prints the notice and waits for a name. **It has to be that device's own user typing it** — the
name becomes the consent record, so anyone typing it on their behalf is inventing evidence. Typing `no`
writes `DECLINED.txt` and the agent never collects on that device.

Then, on the dashboard, the device appears in the approval queue. Click **Approve**. Until you do, the
collector rejects everything from it.

### Check what a device is doing

```
node "C:\ProgramData\CTTIme\agent\cli.js" check         --state-dir "C:\ProgramData\CTTIme"
node "C:\ProgramData\CTTIme\agent\cli.js" status        --state-dir "C:\ProgramData\CTTIme"
node "C:\ProgramData\CTTIme\agent\cli.js" what-collects --state-dir "C:\ProgramData\CTTIme"
type C:\ProgramData\CTTIme\agent.log
schtasks /query /tn "CTTIme Endpoint Visibility" /v /fo LIST
```

`check` is the one to run first when a device is not working. It proves the socket, the certificate
pin, the notice and the enrollment gate, then exits without capturing, enrolling or spooling
anything, so running it against a healthy device disturbs nothing. It exits non-zero when a step
fails and prints the certificate hash the device was actually offered, which is the difference
between "this collector was reinstalled" and "something else is answering on that port". The packaged
agents have the same command: `CTTImeAgent.exe check …`, or
`CTTImeSetup.exe unpack --state-dir C:\temp` to look inside the setup file without installing.

`status` prints enrollment, whether a token is sealed, the policy in force and how deep the upload queue
is. `agent.log` is plaintext and records refusals too, not just successes.

### Reading the agent's own lines

Both clients log the same sentences, and most of them are the gate working, not a fault. What you will
see, and what it actually means:

| Line | Meaning | What to do |
|---|---|---|
| `not collecting: consent_required` | Installed, reachable, waiting. Nobody has acknowledged the notice on this device | The device user runs `run --host … --pin … --interactive` themselves. Not a bug, and not something to script around |
| `not collecting: check_failed` | The line above it is the real reason | Read that line |
| `approval check failed: network collector unreachable` | Nothing is answering that address and port | `netstat -ano \| findstr :8443` on the collector, confirm it is bound to an address the device can reach, then the firewall. Agents queue meanwhile — nothing is lost |
| `approval check failed: tls_pin_mismatch` | The certificate offered is not the pinned one | The collector was reinstalled or re-certificated, or something else is on that port. Re-read the pin and re-install the device. Trying another port is not a fix: extra ports are availability, and a mismatch is terminal by design |
| `not collecting: declined`, with a `DECLINED.txt` in the state folder | The user refused | Recorded and respected. Nothing re-prompts unless they run it interactively |
| `not collecting: revoked` / `rejected` | An admin stopped this device with a reason | Re-enable it on the dashboard, which carries no consent over, or leave it |
| `not collecting: token_issuance_missed` | Approved, but the token never reached the agent | Rotate the device's token from the dashboard |
| a verdict of `Silent for N m` on the dashboard | The agent stopped reporting | Task, machine, pin — in that order |

Four of those reasons (`declined`, `rejected`, `revoked`, `token_issuance_missed`) are terminal: the agent
sits there and collects nothing until a human changes the state on the device or in the dashboard.

### Remove it

```
powershell -File C:\ProgramData\CTTIme\setup\scripts\uninstall.ps1
```

(If you installed by copying the folder, `uninstall.ps1` is in that copy's `scripts` folder instead.
`ABOUT.txt` in the state folder prints the right path for the way your device was installed.)

It stops and unregisters the task, then deletes the state folder — code, config, log, queue and the
sealed token. `-KeepData` leaves the logs and queue in place for an audit. Data the collector already
received stays there until retention ages it out or an admin deletes it; **revoke the device on the
dashboard** so the revocation is recorded with a reason. The device row and its consent record are kept
on purpose.

## The dashboard

The Overview answers the one question that matters after an install: **is anything actually arriving,
and if not, which step is stuck.** Four things have to happen in order — an agent enrolls, the device
user acknowledges the notice, an admin approves, the round trip confirms — and the page shows how many
devices have cleared each one. Every device row carries a verdict in that same language, so a list of
"Approved" rows cannot hide an agent that never called in:

| Verdict | What it means |
|---|---|
| Waiting for you | Enrolled and acknowledged, sitting in the approval queue |
| Approved, agent has not called in | You approved it; the agent has not come to collect its token yet |
| Token issued, no request yet | It has the token but no authenticated request has arrived — check the machine, the route, the task |
| Talking, but no data accepted yet | Requests are landing; nothing has been written yet |
| Confirmed working | Data accepted, and still reporting inside the heartbeat window |
| Silent for *N*m | It stopped reporting — check the task, the pin, or the machine |
| Rejected / Revoked | Recorded with the actor, the time, and the reason on the device page |

Open a device and use **Confirm this device** to see the five stamps in order with their times, so a
half-installed fleet is a list of named gaps rather than a mystery.

| Page | What it is for |
|---|---|
| Overview | The four-step list, totals, the approval queue, and the verdict column |
| Screenshots | Captured frames, newest first, filterable by device |
| Extensions | Browser add-on inventory per device and browser |
| Clipboard | Counts, sizes and a coarse content label. There is no text column to look at |
| Telemetry health | Which devices are still reporting, how much they sent, and which are running an old policy |
| Audit log | Every approval, revocation and policy edit, with actor and time |
| Policy | Capture interval, retention, what is enabled, and the notice wording |
| Help | This material, inside the product |

Policy changes are validated against bounds before they are written, and reach running agents on their
next heartbeat without a restart. Bumping `notice_version` on the Policy page sends every device back
through the agreement step — consent is never inherited across a wording change.

## Verify it

```
node test\run.js
```

58 acceptance checks covering the consent gate, the wire contract, retention, transport pinning, the
spool, the clipboard's absence of content, multi-port failover, the connection pop-ups shown to the
device user, and a real screenshot capture on the host running them.

To see what one collector box can take:

```
node scripts\perf-bench.js
```

It boots a throwaway collector on a loopback port in `.tmp\perf`, drives the heartbeat, batch and
screenshot routes as agents would, and fails if any event it sent is unaccounted for. The measured
figures are in [docs/README.md](docs/README.md).

## Not in this version

- No macOS or Linux agent, and no way to build one from a Windows machine.
- No roles or read-only logins: every dashboard account is a full administrator.
- No central management of the collector's own certificate beyond `scripts\make-cert.js --rotate`,
  which invalidates every pin and means re-installing each device.
- No alerting, no export of screenshots in bulk, no reporting.
- No smart-card or SSO login; passwords only, hashed with scrypt.

## Read before deploying

[docs/API-CONTRACT.md](docs/API-CONTRACT.md) is the source of truth between the agent and the
collector. [docs/NOTICE-TEMPLATE.md](docs/NOTICE-TEMPLATE.md) is the wording users see.
[docs/PACKAGING.md](docs/PACKAGING.md) covers the single-file build and its limits.
[docs/LAWFUL-USE.md](docs/LAWFUL-USE.md) separates what this software enforces from what the
deployment has to supply. [docs/README.md](docs/README.md) indexes the rest and lists what v1 does
not do.

A consent record is not the same thing as consent. The database can prove that a name was typed at a
notice on a date; it cannot prove the person understood it, was not rushed, or was the actual device
user. The policy that authorises this deployment — who is covered, for what purpose, for how long, and
who reviews it — is a document you have to write and sign separately. Nothing here substitutes for it.
