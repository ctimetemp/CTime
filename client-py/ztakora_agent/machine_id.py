import hashlib
import os
import re
import subprocess
import sys
import uuid

try:
    import winreg
except ImportError:
    winreg = None

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
GUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def _run(cmd, timeout):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          creationflags=_NO_WINDOW, stdin=subprocess.DEVNULL).stdout


# Windows exposes a stable per-installation identifier at
#   HKLM\SOFTWARE\Microsoft\Cryptography  MachineGuid
# which any admin can read with `reg query`. It is the same value MDM and asset tooling use, so it
# is used openly here rather than reconstructed from hidden sources.
def read_machine_guid():
    if winreg is not None:
        # The 64-bit view first: a 32-bit reader would be handed the redirected value, which is a
        # different GUID and would enroll the machine as a second device.
        for view in (getattr(winreg, "KEY_WOW64_64KEY", 0), getattr(winreg, "KEY_WOW64_32KEY", 0)):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                    "SOFTWARE\\Microsoft\\Cryptography", 0,
                                    winreg.KEY_READ | view) as key:
                    value, _ = winreg.QueryValueEx(key, "MachineGuid")
            except OSError:
                continue
            if isinstance(value, str) and GUID_RE.match(value.strip()):
                return value.strip()
    for attempt in (
        lambda: _run(["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], 15),
        lambda: _run(["powershell", "-NoProfile", "-Command",
                      "(Get-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid"], 20),
    ):
        try:
            out = attempt()
        except (OSError, subprocess.SubprocessError):
            continue
        match = re.search(r"MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})", out)
        value = match.group(1) if match else out.strip()
        if value and len(value) >= 8 and not re.search(r"ERROR|Cannot find", value, re.I):
            return value
    return None


def persisted_fallback_id(file):
    """Only used when the registry value is unavailable. Persisted so identity at least stays
    stable on that box; without persistence every restart enrolls a brand-new device row."""
    try:
        with open(file, encoding="utf8") as fh:
            existing = fh.read().strip()
        if existing:
            return {"id": existing, "source": "file"}
    except OSError:
        pass
    generated = hashlib.sha256(
        f"{uuid.uuid4()}|{os.environ.get('COMPUTERNAME', 'unknown-host')}".encode()).hexdigest()
    try:
        with open(file, "w", encoding="utf8") as fh:
            fh.write(generated)
    except OSError:
        pass
    return {"id": generated, "source": "generated"}


def smb_uuid():
    try:
        out = _run(["powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance Win32_ComputerSystemProduct).UUID"], 20).strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out if re.fullmatch(r"[0-9a-fA-F-]{32,36}", out) else None
