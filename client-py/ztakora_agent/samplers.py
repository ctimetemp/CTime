import os
import re
import uuid

from . import probes

HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
KINDS = frozenset({"text", "file-list", "image", "empty"})
ALLOWED_CLIPBOARD_KEYS = frozenset({"char_count", "sha256", "content_kind"})


def _quiet_unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


class Capturer:
    """Screen capture runs in a PowerShell child using System.Drawing, so no native Python module
    is loaded. The lock/idle probe and the capture happen in one invocation: the session state has
    to be read at the moment of capture or "we skipped this frame because it was locked" would be a
    claim about some other moment."""

    def __init__(self, work_dir, on_warn=lambda message: None):
        os.makedirs(work_dir, exist_ok=True)
        self.work_dir = work_dir
        self._warn = on_warn

    def capture(self, idle_skip_seconds=None, skip_when_locked=True, timeout_ms=25000):
        target = os.path.join(self.work_dir, f"{uuid.uuid4()}.png")
        value, error = probes.run_json("capture.ps1", args=[target], timeout=timeout_ms / 1000)
        if value is None:
            _quiet_unlink(target)
            return {"state": "active", "captured": False, "reason": error}
        idle_seconds = value.get("idle_seconds") or 0
        # A probe that failed reports why instead of vetoing the frame. idle_seconds stays 0, which
        # reads as "someone is at this desk", and the warning is the only signal that the counter is
        # not answering -- the alternative is an agent that quietly stops recording.
        for key, label in (("idle_probe", "idle probe"), ("desktop_probe", "desktop probe")):
            state_name = value.get(key)
            if state_name and state_name != "ok":
                self._warn(f"{label} {state_name}; capturing without that verdict")
        if skip_when_locked is not False and value.get("locked"):
            _quiet_unlink(target)
            return {"state": "locked", "captured": False, "idle_seconds": idle_seconds}
        idle_known = value.get("idle_probe") not in ("error", "unavailable")
        if idle_known and isinstance(idle_skip_seconds, (int, float)) and idle_skip_seconds >= 0 \
                and idle_seconds > idle_skip_seconds:
            _quiet_unlink(target)
            return {"state": "idle", "captured": False, "idle_seconds": idle_seconds}
        if not value.get("captured"):
            return {"state": "active", "captured": False, "reason": value.get("error") or "no capture"}
        try:
            with open(target, "rb") as fh:
                png = fh.read()
        except OSError as err:
            return {"state": "active", "captured": False, "reason": str(err)}
        finally:
            _quiet_unlink(target)
        if not png:
            return {"state": "active", "captured": False, "reason": "empty png"}
        return {"state": "active", "captured": True, "png": png,
                "width": value.get("width"), "height": value.get("height"),
                "idle_seconds": idle_seconds, "cells": value.get("gray_cells")}


class ClipboardSampler:
    """Clipboard metrics only. The hashing happens inside the PowerShell child and the only things
    that come back are char_count, sha256 and content_kind, so clipboard text never crosses a
    process boundary, never sits in this process's heap, and cannot be logged by an errant print.

    There is no code path here that can emit clipboard text; see QODER.md non-negotiable 3."""

    def __init__(self, work_dir, on_warn=lambda message: None):
        os.makedirs(work_dir, exist_ok=True)
        self._warn = on_warn

    def __call__(self, timeout_ms=12000):
        value, error = probes.run_json("clipboard_probe.ps1", timeout=timeout_ms / 1000, sta=True)
        if value is None:
            self._warn(f"clipboard probe failed: {error}")
            return None
        if not isinstance(value, dict) or not {k.lower() for k in value} <= ALLOWED_CLIPBOARD_KEYS:
            self._warn("clipboard probe returned unexpected keys; discarding sample")
            return None
        sha = value.get("sha256")
        char_count = value.get("char_count")
        kind = value.get("content_kind")
        if not isinstance(sha, str) or not HEX64_RE.match(sha):
            return None
        if not isinstance(char_count, int) or isinstance(char_count, bool) or char_count < 0:
            return None
        if kind not in KINDS:
            return None
        return {"char_count": char_count, "sha256": sha, "content_kind": kind}
