import json
import os

# These defaults exist for exactly one situation: a policy key is absent from the server document
# or arrives listed in a `removed` diff. The client never picks an interval, threshold or flag on
# its own when the server has one, and this table must match docs/API-CONTRACT.md section 5.
AGENT_DEFAULTS = {
    "screenshot_interval_minutes": 5,
    "screenshot_retention_days": 30,
    "screenshot_max_bytes": 8388608,
    "clipboard_metrics_enabled": True,
    "extension_inventory_enabled": True,
    "clipboard_sample_seconds": 300,
    "heartbeat_interval_seconds": 300,
    "batch_max_items": 200,
    "batch_max_bytes": 262144,
    "batch_max_age_seconds": 120,
    "spool_max_bytes": 134217728,
    "skip_when_locked": True,
    "idle_skip_seconds": 600,
    "dedupe_unchanged_frames": True,
    "ext_inventory_max_age_hours": 24,
}

BOOL_KEYS = frozenset({"clipboard_metrics_enabled", "extension_inventory_enabled",
                       "skip_when_locked", "dedupe_unchanged_frames"})


def _normalise(key, value):
    if key in BOOL_KEYS:
        return value is True or value == "true"
    if key == "notice_version":
        return "" if value is None else str(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return value
    return int(number) if number.is_integer() else number


class PolicyState:
    def __init__(self, file, on_warn=lambda message: None):
        self._file = file
        self._warn = on_warn
        self._etag = None
        self._values = dict(AGENT_DEFAULTS)
        try:
            with open(file, encoding="utf8") as fh:
                stored = json.load(fh)
            self._etag = stored.get("etag")
            self._values = {**AGENT_DEFAULTS, **(stored.get("values") or {})}
        except OSError:
            pass
        except (ValueError, AttributeError):
            pass

    @property
    def etag(self):
        return self._etag

    @property
    def values(self):
        return dict(self._values)

    def _save(self):
        try:
            with open(self._file, "w", encoding="utf8") as fh:
                fh.write(json.dumps({"etag": self._etag, "values": self._values}, indent=2))
        except OSError as err:
            self._warn(f"policy save: {err}")

    def replace(self, doc, etag):
        # Full document from GET /config: adopted wholesale, so a key the server dropped falls back
        # to the documented default instead of persisting as a stale local value. Unknown keys are
        # ignored rather than stored, so they cannot linger after the server stops sending them.
        values = dict(AGENT_DEFAULTS)
        for key, value in (doc or {}).items():
            if key in AGENT_DEFAULTS:
                values[key] = _normalise(key, value)
        self._etag = etag
        self._values = values
        self._save()
        return dict(self._values)

    def apply_diff(self, changed=None, removed=None, etag=None):
        for key, value in (changed or {}).items():
            if key in AGENT_DEFAULTS:
                self._values[key] = _normalise(key, value)
        for key in (removed or []):
            if key in AGENT_DEFAULTS:
                self._values[key] = AGENT_DEFAULTS[key]
        if etag:
            self._etag = etag
        self._save()
        return dict(self._values)

    def set_etag(self, etag):
        self._etag = etag
        self._save()

    def describe(self):
        return {**self._values,
                "_note": "All intervals, thresholds and flags are set by the collector server. "
                         "Values here are what this device is currently running."}
