# CTTIme agent — Python client

The monitoring client, written against the standard library only. Same wire contract as `agent/`
(see `docs/API-CONTRACT.md`), same consent gate, same disclosure files. A device runs one client or
the other, never both.

Read `QODER.md` first. The five non-negotiables there are enforced by this code, not by convention:
the agent is discoverable, it collects nothing before the device user acknowledges the notice,
clipboard sampling is metrics-only with no code path able to carry text, screenshots are
interval-based with no OCR, and nothing about it resists inspection.

## Run it

```
python client-py check --host <collector-ip> --pin <64-hex>
python client-py run --host <collector-ip> --pin <64-hex> --interactive
python client-py one-shot --host <collector-ip> --pin <64-hex>
python client-py status
python client-py what-collects
```

`python client-py` works because `client-py/__main__.py` is the entry point; `python -m CTTIme_agent`
does the same thing from inside this directory. `--pin` is mandatory: it is the SHA-256 of the
collector's certificate DER, printed by `node scripts/make-cert.js --check` at install time. There is
no plaintext fallback, no CA bypass and no negotiated downgrade — a pin mismatch aborts before a
byte leaves the machine.

Tested on CPython 3.14.7, Windows 11. The floor is 3.10, because `phash.hamming()` uses
`int.bit_count()`. `--state-dir` overrides `%PROGRAMDATA%\CTTIme`, which is what makes a test run on
a dev box possible.

## Layout

| file | what it is |
|------|------------|
| `CTTIme_agent/agent.py` | enrollment, consent, scheduler, run loop |
| `CTTIme_agent/transport.py` | pinned TLS, one keep-alive connection, request shapes |
| `CTTIme_agent/spool.py` | on-disk segments and blobs, cap enforcement, dropped counter |
| `CTTIme_agent/flush.py` | heartbeat → batch → screenshots, backoff, duplicate-safe acks |
| `CTTIme_agent/producers.py` | screenshot / clipboard / extension ticks, dedupe |
| `CTTIme_agent/samplers.py` | capture and clipboard wrappers, key whitelist re-asserted |
| `CTTIme_agent/probes/*.ps1` | the audited capture, clipboard and DPAPI children |
| `CTTIme_agent/extensions.py` | Chrome/Brave/Edge/Firefox extension readers |
| `CTTIme_agent/token.py` | DPAPI seal/unseal of the device token |
| `build-exe.py` | PyInstaller build for `dist/CTTImeAgent.exe` |

Capture, clipboard sampling and DPAPI stay in PowerShell children rather than Python modules: those
three are the paths a reviewer has to trust, they need no native dependency, and the clipboard hash
never has to re-enter this process.

## Build the executable

```
python -m pip install pyinstaller     # build-time only, never needed on a device
python client-py/build-exe.py
```

See `docs/PACKAGING.md` for what lands inside the file and how to install from it.

## Installing on a device

```
.\scripts\install.ps1 -CollectorHost <ip> -Pin <64-hex> -Client python
.\scripts\install.ps1 -CollectorHost <ip> -Pin <64-hex> -Client python -AgentExe <path\to\CTTImeAgent.exe>
```

`-Acknowledge` shows the notice to the signed-in user and takes **their** name. Never type it for
them, and never script it: the collector stores the acknowledgment as the consent record, and a
proxy-filled name makes the record false.
