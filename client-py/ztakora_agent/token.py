import base64
import os

from . import probes


class TokenHolder:
    """The bearer token lives in memory once opened and never in the agent's own log lines."""

    def __init__(self, value=None):
        self.value = value

    def headers(self):
        return {"authorization": f"Bearer {self.value}"} if self.value else {}

    def present(self):
        return bool(self.value)

    def set(self, value):
        self.value = value

# DPAPI CurrentUser seal. The device token is bound to this Windows user's master key, so a copy of
# token.bin taken to another account or another machine cannot be opened. That is what CurrentUser
# scope means; config.json states it plainly rather than presenting it as stronger.
#
# The secret travels to PowerShell over stdin, never as a command-line argument: command lines are
# visible in the process list and in Sysmon EID 1 logs.


def seal_token(token, file):
    payload = base64.b64encode(token.encode("utf8")).decode("ascii")
    result = probes.run("dpapi_protect.ps1", stdin_text=payload)
    if not result["ok"]:
        raise RuntimeError(f"dpapi failed: {result['error']}")
    sealed = result["stdout"]
    if not sealed:
        raise RuntimeError("dpapi failed: empty output")
    with open(file, "w", encoding="utf8") as fh:
        fh.write(sealed)
    try:
        os.chmod(file, 0o600)
    except OSError:
        pass
    return file


def open_token(file):
    try:
        with open(file, encoding="utf8") as fh:
            sealed = fh.read().strip()
    except OSError:
        return None
    if not sealed:
        return None
    result = probes.run("dpapi_unprotect.ps1", stdin_text=sealed)
    if not result["ok"]:
        return None
    # A different Windows user opened this process, or the master key rotated: the token is
    # unrecoverable by design and an admin must rotate it.
    try:
        return base64.b64decode(result["stdout"]).decode("utf8") or None
    except (ValueError, UnicodeDecodeError):
        return None
