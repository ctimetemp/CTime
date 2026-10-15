"""Tells the device user, on their own screen, when the thing watching their workstation stops
talking to the collector, starts again, or cannot be verified.

Mirrors ``agent/lib/notify.js`` -- same kinds, same wording, same throttle windows, same record file
-- because the two clients must not tell the person at the keyboard different stories. The wording is
a disclosure, so it is copied verbatim rather than reworded; nothing in it comes from the network.

What this deliberately is not: a security control. A balloon cannot prove anything to the user, the
text is authored in this file, and anyone with write access to the binary could change it. The trust
anchor stays the pinned certificate fingerprint; this is disclosure, and it is why the notice text
says the same thing in words.
"""

import json
import os
import re
import subprocess
import sys
import time

from .clock import now_iso

try:
    from . import probes as _probes
except ImportError:  # pragma: no cover - the shipped package always has the probe runner
    _probes = None

# Written to the work directory and run as a child, exactly as on the Node client. Kept byte-for-byte
# identical to agent/lib/notify.js, comments included, because the message pump inside it is the whole
# reason a balloon appears at all.
SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$out = @{ shown = $false; via = 'none'; error = $null }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $icon.BalloonTipTitle = [string]$Args[0]
  $icon.BalloonTipText = [string]$Args[1]
  $icon.Visible = $true
  $icon.ShowBalloonTip([int]$Args[2])
  # A balloon is only painted while the thread pumps messages. Without this loop the call returns,
  # the icon is disposed, and the shell never draws anything -- which is exactly the silent failure
  # this module exists to prevent.
  $until = (Get-Date).AddSeconds(([int]$Args[2] / 1000) + 2)
  while ((Get-Date) -lt $until) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
  $icon.Visible = $false
  $icon.Dispose()
  $out.shown = $true
  $out.via = 'balloon'
} catch {
  $out.error = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
"""

# Windows clips a balloon it cannot fit around 200-300 characters and the rest becomes an ellipsis,
# so the text is written to fit rather than truncated at display time.
MAX_TITLE = 63
MAX_TEXT = 240
HISTORY = 20

# The child gets well over the balloon's own lifetime: the pump loop above runs for the display
# duration plus two seconds, and a notice that is slow to paint is still a notice.
BALLOON_MS = 8000
RUN_TIMEOUT_SECONDS = 25
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# The things the user is told about. Wording is factual: what happened, what it means for their data,
# and what they can do. Never "press OK to continue".
ALERTS = {
    "online": {
        "title": "CTTIme: reporting to the company collector",
        "text": "This managed device is sending its monitoring data to the company collector again. "
                "Nothing collected during the gap was deleted; it was buffered on this device and is "
                "being uploaded now.",
    },
    "offline": {
        "title": "CTTIme: cannot reach the collector",
        "text": "This managed device cannot reach the company collector right now. It keeps buffering "
                "data locally on this machine and will upload it when the connection returns. "
                "Read the notice with: CTTImeAgent.exe what-collects",
    },
    "unverified": {
        "title": "CTTIme: the collector could not be verified",
        "text": "Something answered the company collector address with a certificate this device was "
                "not told to trust. Nothing is uploaded until IT fixes it. The address and fingerprint "
                "are in this device's agent log.",
    },
    "registered": {
        "title": "CTTIme: this device is registered",
        "text": "Your acknowledgment of the monitoring notice was sent to the company collector and "
                "this device is now registered. Nothing at all is collected until an administrator "
                "approves it. Read the notice again: CTTImeAgent.exe what-collects",
    },
    "approved": {
        "title": "CTTIme: monitoring is now active on this device",
        "text": "An administrator approved this device. It has started sending screenshots, browser "
                "extension inventory and clipboard metrics on the schedule set by IT. "
                "What exactly, and how often: CTTImeAgent.exe what-collects",
    },
    # The standing reminder. One balloon per collection day, not one per capture: a popup every
    # minute would be dismissed unread, which teaches the user nothing, while a once-a-day summary
    # keeps the fact that collection is happening in front of them without becoming noise.
    "collecting": {
        "title": "CTTIme: collection summary",
        "text": "Since this agent started {since} ago it sent {screenshots} screenshot(s) and "
                "{events} metric event(s) to the company collector; {dropped} dropped as the local "
                "buffer filled. Company-managed device. List: CTTImeAgent.exe what-collects",
    },
}

# Per-kind throttle windows over the 60s floor. The summary must not become a daily nag and the
# one-shot announcements must not repeat on every recheck.
WINDOWS = {"collecting": 20 * 3600, "registered": 6 * 3600, "approved": 6 * 3600}

_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def fill(text, values):
    """{placeholder} substitution for the summary notices. An unknown key is left visibly unfilled
    rather than silently blanked, so a notice never reads as if it said something when it did not."""
    return _PLACEHOLDER_RE.sub(
        lambda m: str(values[m.group(1)]) if values.get(m.group(1)) is not None else m.group(0),
        text)


class Notifier:
    """Shows the balloon, throttles it per kind, and records what happened in notifications.json so
    `status` can report it after the process has left.

    ``show()`` blocks for the seconds the balloon is on screen. This agent has one thread and every
    kind is throttled to at most one notice per window, so a short stall costs nothing and keeps a
    single writer per record file; the alternative was a second thread racing the scheduler over
    notifications.json."""

    def __init__(self, work_dir, log=None, min_interval_seconds=60, min_seconds_by_kind=None,
                 history_file=None):
        os.makedirs(work_dir, exist_ok=True)
        self.log = log or (lambda message: None)
        self.work_dir = work_dir
        # Next to the record file, in the state directory the device user can open, not inside the
        # bundle: what appears on their screen has to be readable afterwards.
        self.script_path = os.path.join(work_dir, "notify.ps1")
        try:
            with open(self.script_path, "w", encoding="utf8") as handle:
                handle.write(SCRIPT)
        except OSError as err:
            # Without the script nothing can be shown, but a notice still has to be recorded as
            # failed rather than take the agent down at construction.
            self.log(f"notice script could not be written: {err}")
        self.file = history_file or os.path.join(work_dir, "notifications.json")
        self.min_interval_seconds = min_interval_seconds
        self.windows = dict(WINDOWS)
        if min_seconds_by_kind:
            self.windows.update(min_seconds_by_kind)

        self.state = {"sent": 0, "failed": 0, "lastShownAt": {}, "history": []}
        # Only a record that lives in the work directory is read back, exactly as on the Node client:
        # an alternate history file is a write target, not a second copy of this device's record.
        if os.path.dirname(os.path.abspath(self.file)) == os.path.abspath(work_dir):
            self.state.update(self._read_file())
        self.state["lastShownAt"] = self.state.get("lastShownAt") or {}
        self.state["history"] = list(self.state.get("history") or [])

    def _read_file(self):
        try:
            with open(self.file, encoding="utf8") as handle:
                stored = json.load(handle)
        except (OSError, ValueError):
            return {}  # first run
        return stored if isinstance(stored, dict) else {}

    def _persist(self):
        try:
            with open(self.file, "w", encoding="utf8") as handle:
                handle.write(json.dumps({
                    **self.state,
                    "lastShownAt": self.state["lastShownAt"],
                    "history": self.state["history"][:HISTORY],
                }))
        except OSError:
            # The record is a courtesy to the device user, not a collection dependency.
            pass

    def window_for(self, kind):
        return self.windows.get(kind, self.min_interval_seconds)

    def should_show(self, kind):
        since = self.state["lastShownAt"].get(kind)
        if not isinstance(since, (int, float)) or isinstance(since, bool):
            return True
        return not (_now_ms() - since < self.window_for(kind) * 1000)

    def _record(self, kind, entry):
        self.state["history"] = [entry] + self.state["history"][:HISTORY - 1]
        if entry.get("shown"):
            self.state["sent"] += 1
            self.state["lastShownAt"][kind] = _now_ms()
        else:
            self.state["failed"] += 1
        self._persist()

    def show(self, kind, overrides=None):
        """Returns the entry it recorded, or the verdict for an unknown/suppressed kind. Never raises:
        a notice this host cannot paint must not stop the agent that is also a collector."""
        overrides = overrides or {}
        alert = ALERTS.get(kind)
        if alert is None:
            return {"shown": False, "via": "none", "reason": f"unknown alert {kind}"}
        if not self.should_show(kind):
            return {"shown": False, "via": "suppressed", "reason": "already announced"}
        text = fill(str(alert["text"] if overrides.get("text") is None else overrides["text"]),
                    overrides.get("values") or {})
        title = str(alert["title"] if overrides.get("title") is None else overrides["title"])
        try:
            res = self._run(title[:MAX_TITLE], text[:MAX_TEXT])
        except Exception as err:
            res = {"shown": False, "via": "none", "error": str(err)}
        entry = {"kind": kind, "at": now_iso(), **res}
        self._record(kind, entry)
        if not res["shown"]:
            # The popup failing is itself reported, one level down: the local log is the record that
            # the device user was not told, and `status` shows the same count.
            self.log(f"notice '{kind}' could not be shown "
                     f"({res.get('error') or res.get('reason') or 'unknown'}); "
                     "recorded in the agent log instead")
        else:
            self.log(f"notice '{kind}' shown to the device user")
        return entry

    def _run(self, title, text, ms=BALLOON_MS):
        result = self._spawn(title, text, ms)
        if result.get("error"):
            return {"shown": False, "via": "none", "error": result["error"]}
        try:
            parsed = json.loads(result["stdout"])
        except ValueError:
            return {"shown": False, "via": "none",
                    "error": f"notify exited {result.get('returncode')} with no verdict"}
        if not isinstance(parsed, dict):
            return {"shown": False, "via": "none",
                    "error": f"notify exited {result.get('returncode')} with no verdict"}
        return {"shown": bool(parsed.get("shown")), "via": parsed.get("via"),
                "error": parsed.get("error") or None}

    def _spawn(self, title, text, ms):
        # The package probe runner already owns the PowerShell child mechanics (the -NoProfile
        # -NonInteractive -ExecutionPolicy Bypass -File shape, the hidden window flag, the timeout
        # and the stdout capture), so the notice goes through it instead of a second copy of that
        # code. It takes an absolute path, because this script lives in the state directory rather
        # than in the bundle's probes folder.
        if _probes is not None and hasattr(_probes, "run"):
            result = _probes.run(self.script_path, args=[title, text, str(ms)],
                                 timeout=RUN_TIMEOUT_SECONDS)
            if result.get("ok"):
                return {"stdout": result["stdout"], "returncode": result.get("returncode", 0)}
            return {"error": result.get("error")}
        # Without the runner: the same command line the Node client spawns directly.
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
               "-File", self.script_path, title, text, str(ms)]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=RUN_TIMEOUT_SECONDS,
                                  creationflags=_NO_WINDOW)
        except subprocess.TimeoutExpired:
            return {"error": f"notify timed out after {RUN_TIMEOUT_SECONDS}s"}
        except OSError as err:
            return {"error": str(err)}
        out = (proc.stdout or "").strip()
        if proc.returncode != 0 and not out:
            return {"error": ((proc.stderr or "").strip() or f"exit {proc.returncode}")[:200]}
        return {"stdout": out, "returncode": proc.returncode}

    def history(self):
        # `status` and `check` read the file from disk rather than this; the device user (or whoever
        # they call from IT) can see that the agent did or did not tell them something, instead of
        # the agent being the only witness. This is the same view for a caller holding a live
        # notifier.
        items = self.state["history"]
        return {"sent": self.state["sent"], "failed": self.state["failed"],
                "last": items[0] if items else None, "items": items[:5]}


def _now_ms():
    return int(time.time() * 1000)
