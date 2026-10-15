from datetime import datetime, timezone


def now_iso():
    """ISO-8601 UTC with millisecond precision and a trailing Z, the only timestamp shape the
    collector's validator accepts."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_from_epoch(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")
