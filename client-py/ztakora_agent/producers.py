import hashlib
import json
import os
import random
import time
import uuid

from .clock import now_iso
from .extensions import read_extension_inventory
from .phash import dhash, is_unchanged

MAX_LINE_BYTES = 8192


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def envelope(event_type, device_id, data, ts=None):
    """Every event has exactly these fields. A producer that invents a field is caught by the
    server's validators, not quietly tolerated here."""
    return {"event_id": str(uuid.uuid4()), "type": event_type, "device_id": device_id,
            "ts": ts or now_iso(), "data": data}


def backoff_delay(attempt, base_ms=2000, cap_ms=120000, rand=random.random):
    """Full-jitter exponential backoff. Full jitter rather than equal jitter is what keeps fifty
    devices that lost the collector together from stampeding back on the same schedule.

    The defaults are the agent's reconnect policy, not a generic helper: base 2s, ceiling 2min. An
    outage costs the dashboard nothing because the spool holds everything, but a device whose link
    came back thirty seconds ago should not sit silent for fifteen minutes before it says so -- and
    the connection watch wakes it even earlier than this ceiling."""
    ceiling = min(cap_ms, base_ms * 2 ** min(attempt, 20))
    return int(rand() * ceiling)


class Producers:
    def __init__(self, spool, policy, device_id, capture, sample_clipboard, log):
        self.spool = spool
        self.policy = policy
        self.device_id = device_id
        self.capture = capture
        self.sample_clipboard = sample_clipboard
        self.log = log
        self.last_frame_phash = None
        self.last_frame_sha = None
        # The last capture failure this process has already put in the log. Screen states say only
        # 'active', so without this an agent in a session that cannot grant a screen handle looks
        # perfectly healthy on the dashboard while producing no frames at all.
        self.last_capture_reason = None
        self.blob_meta = {}
        self._gist_file = None
        self._seen_gists = {}
        self._last_inventory_at = 0.0

    def load_gists(self, state_dir):
        self._gist_file = os.path.join(state_dir, "extension-gists.json")
        try:
            with open(self._gist_file, encoding="utf8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError):
            return
        self._last_inventory_at = float(raw.pop("__at", 0) or 0)
        self._seen_gists = raw

    def save_gists(self):
        if not self._gist_file:
            return
        try:
            with open(self._gist_file, "w", encoding="utf8") as fh:
                fh.write(json.dumps({**self._seen_gists, "__at": self._last_inventory_at}))
        except OSError:
            pass

    def screenshot_tick(self):
        """Ordering matters: the lock/idle check happens before capture (zero pixels for an
        unattended machine) and the perceptual comparison happens after capture but before the
        spool write (an unchanged screen never becomes an uploadable blob)."""
        values = self.policy.values
        if not values.get("screenshot_interval_minutes"):
            return {"skipped": "policy"}
        result = self.capture(idle_skip_seconds=values.get("idle_skip_seconds"),
                              skip_when_locked=values.get("skip_when_locked"))
        ts = now_iso()
        if not result["captured"]:
            reason = result.get("reason")
            # A capture that could not happen is stated in the log, once per distinct reason, so a
            # host that cannot grant a screen handle does not look healthy while producing nothing.
            if reason and reason != self.last_capture_reason:
                self.log(f"capture unavailable: {reason}")
                self.last_capture_reason = reason
            state = "active" if reason else result["state"]
            self.spool.append(envelope("screen_state", self.device_id(),
                                       {"sampled_at": ts, "state": state}, ts))
            return {"skipped": result["state"], "reason": reason}
        png = result["png"]
        phash = dhash(result.get("cells"))
        sha = sha256_hex(png)
        if values.get("dedupe_unchanged_frames") and phash and self.last_frame_phash \
                and is_unchanged(self.last_frame_phash, phash):
            # Upload nothing, but record the decision so the dashboard shows an intentional gap
            # rather than a hole. The reference frame is deliberately not replaced.
            self.spool.append(envelope("screenshot_skipped_unchanged", self.device_id(),
                                       {"captured_at": ts, "sha256": self.last_frame_sha or sha,
                                        "phash": phash}, ts))
            return {"skipped": "unchanged", "phash": phash}
        if len(png) > values.get("screenshot_max_bytes", 0):
            self.log(f"capture {len(png)}b exceeds screenshot_max_bytes; recording as oversized")
            self.spool.append(envelope("screen_state", self.device_id(),
                                       {"sampled_at": ts, "state": "active"}, ts))
            return {"skipped": "oversized"}
        # The blob name carries the event id, so a crash between writing and flushing cannot
        # orphan an unattributable image. No extension here: spool.write_blob adds the .png.
        blob = self.spool.write_blob(str(uuid.uuid4()), png)
        self.blob_meta[blob] = {"sha256": sha, "phash": phash}
        self.last_frame_phash = phash
        self.last_frame_sha = sha
        return {"captured": True, "blob": blob, "bytes": len(png),
                "idle_seconds": result.get("idle_seconds")}

    def clipboard_tick(self):
        values = self.policy.values
        if values.get("clipboard_metrics_enabled") is False:
            return {"skipped": "policy"}
        sample = self.sample_clipboard()
        if not sample:
            return {"skipped": "probe"}
        ts = now_iso()
        self.spool.append(envelope("clipboard_metric", self.device_id(),
                                   {"sampled_at": ts, **sample}, ts))
        return {"appended": True, "kind": sample["content_kind"]}

    def extension_tick(self, force=False):
        """The gate is the source file's mtime+size+sha256, so an unchanged profile costs a stat
        and a hash instead of a parse-and-upload, and a changed profile is still only re-uploaded
        once per ext_inventory_max_age_hours."""
        values = self.policy.values
        if values.get("extension_inventory_enabled") is False:
            return {"skipped": "policy"}
        max_age_s = (values.get("ext_inventory_max_age_hours") or 24) * 3600
        if not force and time.time() - self._last_inventory_at < max_age_s:
            return {"skipped": "not_due"}
        ts = now_iso()
        uploaded = 0
        for entry in read_extension_inventory():
            key = f"{entry['browser']}|{entry['profile']}"
            if not force and self._seen_gists.get(key) == entry["gist"]:
                continue
            self.spool.append(envelope("extension_inventory", self.device_id(),
                                       {"collected_at": ts, "browser": entry["browser"],
                                        "profile": entry["profile"],
                                        "extensions": entry["extensions"]}, ts))
            self._seen_gists[key] = entry["gist"]
            uploaded += 1
        if uploaded or force:
            self._last_inventory_at = time.time()
        self.save_gists()
        return {"uploaded": uploaded}

    def blob_meta_for(self, file):
        return self.blob_meta.get(file, {})

    def forget_blob(self, file):
        self.blob_meta.pop(file, None)

    def pending_blob_bytes(self):
        total = 0
        for file in self.spool.pending_blob_files():
            try:
                total += os.path.getsize(file)
            except OSError:
                pass
        return total
