# Documentation index

Start with the root [README.md](../README.md): what the product is, what it needs, how to run the
collector, how to put an agent on a device, and how to remove it. This file indexes the rest and
records what v1 deliberately does not do.

| Document | Read it when |
|---|---|
| [GUIDE.md](GUIDE.md) | You are installing, building or operating it. Plain words, runnable commands, troubleshooting table |
| [LAWFUL-USE.md](LAWFUL-USE.md) | Before the first device is installed, and by whoever signs the Acceptable Use Policy. What the code enforces versus what the deployment must supply |
| [API-CONTRACT.md](API-CONTRACT.md) | Changing anything on the wire between agent and collector. It is the source of truth for both clients and is frozen for v1 |
| [NOTICE-TEMPLATE.md](NOTICE-TEMPLATE.md) | Editing what the device user reads and acknowledges. The text between the markers is served verbatim |
| [PACKAGING.md](PACKAGING.md) | Building `CTTImeSetup.exe` / `CTTImeAgent.exe`, or checking a build you were handed |
| [../client-py/README.md](../client-py/README.md) | Running or building the Python client instead of the Node one |

## Repository layout

```
server/          collector: HTTP+TLS listener, routes, dashboard renderer, sqlite schema
  lib/routes/    device API, admin API, page renderer
  lib/           policy bounds, consent trigger helpers, retention sweep, spool-free ingest
agent/           Node client (zero npm dependencies)
client-py/       Python client (standard library only), same contract
scripts/         installer, uninstaller, cert generator, account tool, single-file build, bench
test/run.js      acceptance harness: 58 checks against the real collector
docs/            this folder
```

Both clients implement the same contract and the same gates. A device runs one or the other.

## Commands

```
node server\index.js              run the collector (binds 127.0.0.1 unless CTTIme_BIND is set)
node scripts\make-account.js NAME create or rotate a dashboard account
node scripts\make-cert.js         generate or rotate the collector certificate
node scripts\build-agent-exe.js   build the single-file setup exe
python client-py\build-exe.py     build the single-file Python agent exe
node test\run.js                  acceptance harness (58 checks)
node scripts\perf-bench.js        ingest bench
```

Environment overrides for the collector: `CTTIme_PORT` (8443), `CTTIme_BIND` (127.0.0.1),
`CTTIme_DATA` (holds the database, certificates and screenshot blobs),
`CTTIme_BOOTSTRAP_ACCOUNT` (`name:password`, for automation only — it is written to the database
and then behaves like any other account).

## Measured behaviour

`node scripts/perf-bench.js --devices=50 --batches=20 --events=50 --shots=60 --shot-kb=512
--concurrency=50` on one Windows 11 box, Node 24, loopback TLS, collector and bench on the same
machine. Synthetic devices acknowledged by `SYNTHETIC BENCH DEVICE - not a real person`, in a
scratch data directory; nothing here touches a live collector.

```
heartbeat              1000 req   p50 30ms   p95 44ms   p99 82ms   1424 req/s
batch ingest           1000 req   p50 172ms  p95 263ms  p99 287ms   275 req/s   13,737 events/s
screenshot stream        60 req   p50 261ms  p95 300ms  p99 303ms   171 req/s   85.4 MiB/s
```

50,050 events sent, 50,050 accepted; re-delivering a stored batch returned `duplicates: 50,
accepted: 0` and stored nothing new. 50k events put the database at 16.1 MiB. Collector memory went
from 109 MiB to 117 MiB while 30 MiB of PNGs streamed to disk, which is what the socket-to-disk pipe
in the contract is supposed to look like.

Read those numbers as "one box on a LAN is not the bottleneck at a few hundred devices", not as a
sizing guarantee: latency is measured against a loopback listener on the same host as the writer,
and a real deployment adds the network and whatever else shares the machine. The bench exits
non-zero if any sent event is unaccounted for, so a fast collector that quietly drops rows fails the
run instead of flattering it.

## Not in v1

This is a deferral list that protects the schedule. These are not bugs, and none of them gets added
without an explicit request.

- **No macOS or Linux agent.** The capture, credential storage and auto-start code is Windows-only,
  and there is no cross-build path from a Windows machine.
- **No roles or read-only logins.** Every dashboard account is a full administrator.
- **No per-record erasure button.** Removal runs through revocation plus the retention sweep, or a
  manual delete while the collector is stopped; see LAWFUL-USE.md.
- **No certificate management beyond `make-cert.js --rotate`**, which invalidates every pin and
  means re-installing every device. No ACME, no internal CA, no pin-rotation protocol.
- **No alerting, no bulk screenshot export, no reporting.** The dashboard is the product's output.
- **No SSO, smart card or MFA.** Passwords only, scrypt-hashed, with login throttling.
- **No agent-initiated remote commands**, no shell, no file push. The agent only ever sends the
  event types in the contract.
- **No proxy, gateway or multi-collector federation**, and no IPv6-only deployment path.

Two things are not on this list because they are not deferred, ever: **OCR or any text extraction
from screenshots**, and **clipboard content**. There is no code path or column for either, and the
collector rejects and audit-logs an upload that tries to send clipboard text. Adding one would make
this a different product than the one described in the notice.

A third refusal, asked for during the build and declined for the same reason: **the contents of
browser extension storage** ("the ldb data of each extension"). The inventory is the metadata a
browser publishes about an installed extension -- name, version, source, declared permissions,
enabled flag -- read from its own preference files. An extension's LevelDB is where that extension
keeps *user* data: a password manager's vault, a cookie jar, form history. Reading it would put
arbitrary personal content into an upload path that has no column able to hold it and no consent
language covering it, and the notice would have to say "whatever your extensions happen to store".
Extension **metadata** is collected; extension **storage** is not.
