# Packaging the agent as a single file

```
node scripts\build-agent-exe.js
```

Produces `dist\CTTImeSetup.exe` — one file you can copy onto a Windows device that has never had Node
installed. Built and verified on Node 26.8.1; `--build-sea` is what makes this possible without
downloading anything, so an older Node needs its own `--build-sea` support or the manual blob-plus-
injector route, which needs a third-party tool and is out of scope for a project with no npm
dependencies.

Options: `--out <dir>`, `--name <file>`, `--runtime <path to node.exe>`, `--keep` (leave the staging
files). Measured on this machine: 9.3 seconds, 137.2 MB output.

## What is inside, and what lands on the device

The executable is a copy of the Node binary with a small CommonJS main grafted onto it, plus every
other file stored gzip-compressed as an embedded asset. On `install` it writes:

```
C:\ProgramData\CTTIme\
  runtime\node.exe            the runtime the scheduled task uses
  setup\agent\**\*.js         the agent, as plain source
  setup\package.json
  setup\scripts\install.ps1   the same installer the folder-copy route uses
  setup\scripts\uninstall.ps1
  setup\scripts\agent-setup-launcher.cjs   the source of the code inside the exe
  setup\scripts\build-agent-exe.js
```

and then runs `install.ps1`, pointing `-NodePath` at the bundled runtime and `-SourceDir` at the
unpacked agent. The installer does the rest: it copies the agent into `C:\ProgramData\CTTIme\agent`,
writes `ABOUT.txt`, registers the visible `CTTIme Endpoint Visibility` task, and starts it.

Two consequences worth being deliberate about:

**The agent is not compiled.** What runs on a device is readable JavaScript, byte-identical to the
source in this repository, and the exe carries its own copy of the installer and launcher so nobody has
to take the build on trust. `dist\PACKAGED-FILES.txt` lists every embedded file with its size and
SHA-256.

**All disclosure behaviour lives in `install.ps1`, not in the exe.** The launcher unpacks and hands off.
It has no policy of its own and cannot weaken any: no notice, no consent record, no approval means no
data, exactly as in the folder-copy route.

## Why not one opaque executable

Three things were tried or checked before settling here:

- `node --build-sea` embeds only a **CommonJS** main. An ESM entry point fails at run time with
  `Cannot use import statement outside a module`, and the config's `type` field is ignored.
- A packaged main script **cannot `import()` an on-disk ESM module**: it fails with
  `ERR_UNKNOWN_BUILTIN_MODULE`. That rules out "embed the sources, unpack them, then run them" from
  inside one process, which is why the exe unpacks and then launches the bundled `node.exe`.
- Flattening the agent into a single file would need a bundler from npm, which the project's
  zero-dependency rule forbids, or a rewrite of the agent out of ESM.

So the honest options were "one file whose logic nobody can read" or "one file you hand out that
installs things you can read". This is the second.

## Checking a build you were given

```
certutil -hashfile CTTImeSetup.exe SHA256
```

Compare against the `.sha256` file that came with it, then look inside without installing anything:

```
CTTImeSetup.exe unpack --state-dir C:\temp\CTTIme-check
C:\temp\CTTIme-check\runtime\node.exe C:\temp\CTTIme-check\setup\agent\cli.js check --host <collector> --port 8443 --pin <64-hex> --state-dir C:\temp\CTTIme-check\state
```

`unpack` writes the same plain `.js` text that the installer would copy, so the pinning code, the
consent gate and the capture limits are readable before anything is registered on a device. The
`check` line then proves the packaged bytes can actually reach your collector and verify its
certificate: it prints `"pin_verified": true` and the enrollment state, captures nothing, and exits
non-zero with the hash it was offered when the pin does not match.

After installing, compare `C:\ProgramData\CTTIme\agent\**` against the repository — the agent files
are not transformed, so a diff is meaningful. Rebuilding from a copy of this repository and comparing
`PACKAGED-FILES.txt` shows what a build was made from; it does not prove who made it. For that you
need a signed binary.

## Expect antivirus friction

An unsigned 137 MB executable that writes a Node runtime into `ProgramData`, reads the clipboard and
registers a logon task is what a lot of malware also does. Defenders may flag it, and they are not
wrong to ask. Practical consequences:

- Do not train anyone to click through a SmartScreen warning. Either sign the build with a code-signing
  certificate, or install from the readable folder route and leave the exe out of it.
- Give your security team `PACKAGED-FILES.txt`, the launcher source, and the fact that the task is named
  and visible in `schtasks /query` before the first alert arrives, not after.
- Nothing here disables, evades or interferes with endpoint security, and there is no flag that hides
  any part of the install. That is a design constraint, not a packaging accident.

## The Python client (`client-py`)

There are two agents in this repository, both speaking the same frozen contract in
`docs/API-CONTRACT.md`: `agent/` (Node, zero npm dependencies) and `client-py/` (Python, standard
library only). Pick one per device. The Python one exists for devices that already run Python and
for admins who would rather hand out an 8.9 MB file than a 137 MB one.

```
python client-py\build-exe.py
```

Produces `dist\CTTImeAgent.exe` with PyInstaller, one file, no Python needed on the device.
Measured on this machine: about 14 seconds, 8.9 MB. Options: `--out <dir>`, `--name <file>`,
`--onedir` (a folder instead of one file; starts faster, unpacks nothing to `%TEMP%`).

PyInstaller is a **build-time** tool only. Nothing it installs is needed on a device and the client
source itself imports nothing outside the standard library, so the zero-dependency rule for the
shipped code still holds. `dist\PACKAGED-FILES-PYTHON.txt` lists every bundled source file with its
size and SHA-256.

What goes in: the interpreter, `CTTIme_agent\**`, the PowerShell probes at
`CTTIme_agent\probes\*.ps1` (capture, clipboard, DPAPI — the audited paths, unchanged from the Node
client), and a readable copy of every `.py` and `.ps1` under `_source\`, so the binary can be opened
and compared rather than trusted.

Install, three routes:

```
# from python.exe, running the copied source tree
.\scripts\install.ps1 -CollectorHost <ip> -Pin <64-hex> -Client python

# or from the packaged exe, no Python on the device
.\scripts\install.ps1 -CollectorHost <ip> -Pin <64-hex> -Client python -AgentExe D:\CTTIme\dist\CTTImeAgent.exe

# or the Node client, unchanged default
.\scripts\install.ps1 -CollectorHost <ip> -Pin <64-hex>
```

`-Client python` copies `client-py\` to `C:\ProgramData\CTTIme\agent-py` instead of `agent\`, and the
scheduled task runs `python.exe -m CTTIme_agent run …` (or the exe) with that folder as its start-in
directory. Everything else is the same installer: same task name, same `ABOUT.txt`, same
`config.json`, same consent gate, same `uninstall.ps1`.

Verified on this machine against a live collector: 23 checks on the source client and 14 on the
packaged exe, covering the no-acknowledgment refusal, enrollment → approval → DPAPI token, batch
accept counts, screenshot ingest with collector-read dimensions, metrics-only clipboard rows, and a
byte-grep for a clipboard canary across the collector's data directory and the device state
directory.

One real difference between the two clients: the Python client's perceptual hash comes from the
grayscale cells the capture probe returns, not from a PNG decode in Python, so its `phash` values are
**not bit-comparable with the Node client's**. They only ever have to match the previous frame from
the same device, which is how the dashboard uses them, but do not build a cross-device similarity
query on the column.

The `%TEMP%\_MEI……` unpacking of a onefile build is another thing a defender will ask about. If you
would rather they did not, use `--onedir` and hand out the folder.

## macOS and Linux

Neither is available, and it is not a build-flag problem:

1. `--build-sea` grafts onto **the Node binary of the machine running it**. A Windows `.exe` can only be
   produced on Windows; a `darwin` binary needs a Mac, a Linux one needs Linux.
2. The agent's four platform-bound subsystems are Windows-only, with no fallback branch anywhere:
   screen capture (`agent/lib/screenshot.js`, PowerShell + .NET `CopyFromScreen`), clipboard sampling
   (`agent/lib/clipboard.js`), the DPAPI-sealed device token (`agent/lib/token.js`), and machine
   identity plus auto-start (`agent/lib/machine-id.js`, the registry `MachineGuid`, and the Task
   Scheduler job).

A port needs, per platform: a capture path (macOS `screencapture` behind Screen Recording permission;
X11/Wayland on Linux, where Wayland deliberately blocks background screen capture), a clipboard reader
(`pbpaste` / `xclip` / Wayland portals), a place to seal the token that is not DPAPI (Keychain, or a
keyring service), and a persistence mechanism. Note that macOS prompts the *user* to allow screen
recording — which is a consent moment of its own, and should be designed alongside the notice rather
than bolted on. Also note that a system-wide Linux daemon or a macOS LaunchDaemon needs root, which
changes the "runs as that user, limited privileges, stops at sign-out" property this design is built
around.
