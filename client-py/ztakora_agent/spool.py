import json
import os
import re
import time

SEGMENT_RE = re.compile(r"^events-(\d{4})\.jsonl$")
SEGMENT_ROLL_BYTES = 1024 * 1024


def _base36(value):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        value, rem = divmod(value, 36)
        out = digits[rem] + out
    return out or "0"


class Spool:
    """A directory of fixed-size JSONL segments.

    Deliberately not SQLite and not one JSON document: an append has to be O(1) and must never
    rewrite existing bytes, because the capture, clipboard and extension paths hand events to this
    synchronously. Eviction is whole-segment and oldest-first, so a bounded spool degrades into a
    visible gap (spool_dropped) rather than into partial-line corruption or unbounded disk growth.
    """

    def __init__(self, dir, max_bytes, segment_bytes=SEGMENT_ROLL_BYTES, on_warn=lambda m: None):
        self.dir = dir
        self.max_bytes = max_bytes
        self.segment_bytes = segment_bytes
        self._warn = on_warn
        self.blobs_dir = os.path.join(dir, "blobs")
        os.makedirs(self.blobs_dir, exist_ok=True)
        self.meta_file = os.path.join(dir, "meta.json")
        self.state = {"dropped": 0, "nextSeq": 1}
        try:
            with open(self.meta_file, encoding="utf8") as fh:
                self.state.update(json.load(fh))
        except OSError:
            pass
        except ValueError:
            pass
        self._current = None

    def _save_meta(self):
        try:
            with open(self.meta_file, "w", encoding="utf8") as fh:
                fh.write(json.dumps(self.state))
        except OSError as err:
            self._warn(f"meta: {err}")

    def _segment_path(self, seq):
        return os.path.join(self.dir, f"events-{seq:04d}.jsonl")

    def _list_segments(self):
        found = []
        for name in sorted(os.listdir(self.dir)):
            match = SEGMENT_RE.match(name)
            if not match:
                continue
            full = os.path.join(self.dir, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size > 0:
                found.append({"file": full, "name": name, "bytes": size,
                              "seq": int(match.group(1))})
        return found

    def _open_current(self):
        if self._current:
            return self._current
        segments = self._list_segments()
        if segments:
            last = segments[-1]
            if last["bytes"] < self.segment_bytes:
                # Resume the newest segment while it still has room; the sequence only advances on
                # a roll.
                self._current = {"fd": os.open(last["file"], os.O_WRONLY | os.O_APPEND),
                                 "file": last["file"], "bytes": last["bytes"], "seq": last["seq"]}
                self.state["nextSeq"] = last["seq"] + 1
                return self._current
            self.state["nextSeq"] = last["seq"] + 1
        self.state["nextSeq"] = max(1, self.state["nextSeq"])
        file = self._segment_path(self.state["nextSeq"])
        self._current = {"fd": os.open(file, os.O_WRONLY | os.O_APPEND | os.O_CREAT),
                         "file": file,
                         "bytes": os.path.getsize(file) if os.path.exists(file) else 0,
                         "seq": self.state["nextSeq"]}
        self.state["nextSeq"] += 1
        self._save_meta()
        return self._current

    @staticmethod
    def _count_lines(file):
        try:
            with open(file, "rb") as fh:
                return fh.read().count(b"\n")
        except OSError:
            return 0

    def _blob_list(self):
        entries = []
        for name in os.listdir(self.blobs_dir):
            if not name.endswith(".png"):
                continue
            full = os.path.join(self.blobs_dir, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            entries.append({"file": full, "name": name, "bytes": stat.st_size,
                            "mtime": stat.st_mtime})
        return sorted(entries, key=lambda e: e["mtime"])

    def totals(self):
        segments = self._list_segments()
        blobs = self._blob_list()
        return {"bytes": sum(s["bytes"] for s in segments) + sum(b["bytes"] for b in blobs),
                "segments": len(segments), "blobs": len(blobs)}

    def enforce_cap(self):
        if not isinstance(self.max_bytes, int) or self.max_bytes <= 0:
            return {"evictedSegments": 0, "evictedEvents": 0, "evictedBlobs": 0}
        evicted = {"evictedSegments": 0, "evictedEvents": 0, "evictedBlobs": 0}
        total = self.totals()
        if total["bytes"] <= self.max_bytes:
            return evicted
        # Blobs first: a screenshot is the largest object and the least loss per item, whereas a
        # segment holds many distinct events.
        for blob in self._blob_list():
            if total["bytes"] <= self.max_bytes:
                break
            self._close_if_needed(blob["file"])
            try:
                os.unlink(blob["file"])
            except OSError:
                continue
            total["bytes"] -= blob["bytes"]
            evicted["evictedBlobs"] += 1
            self.state["dropped"] += 1
        for segment in self._list_segments():
            if total["bytes"] <= self.max_bytes:
                break
            events = self._count_lines(segment["file"])
            if self._current and self._current["file"] == segment["file"]:
                # Never evict the segment being written into; roll it first so the cap is honoured
                # without leaving a dangling fd.
                self.roll()
            try:
                os.unlink(segment["file"])
            except OSError:
                continue
            total["bytes"] -= segment["bytes"]
            evicted["evictedSegments"] += 1
            evicted["evictedEvents"] += events
            self.state["dropped"] += events
        self._save_meta()
        evicted["total"] = self.totals()
        return evicted

    def _close_if_needed(self, file):
        if self._current and self._current["file"] == file:
            try:
                os.close(self._current["fd"])
            except OSError:
                pass
            self._current = None

    def roll(self):
        if self._current:
            self._close_if_needed(self._current["file"])

    def append(self, event):
        line = (json.dumps(event) + "\n").encode("utf8")
        segment = self._open_current()
        if segment["bytes"] + len(line) > self.segment_bytes and segment["bytes"] > 0:
            self.roll()
            segment = self._open_current()
        try:
            os.write(segment["fd"], line)
            segment["bytes"] += len(line)
        except OSError as err:
            self._warn(f"append failed: {err}")
            self.state["dropped"] += 1
            self._save_meta()
            self._current = None
            return {"ok": False, "reason": str(err)}
        return {"ok": True, "segment": os.path.basename(segment["file"]), "bytes": len(line),
                "cap": self.enforce_cap()}

    def write_blob(self, name, data):
        clean = re.sub(r"[^A-Za-z0-9._-]", "_", name)
        full = os.path.join(self.blobs_dir, f"{_base36(int(time.time() * 1000))}-{clean}.png")
        tmp = full + ".part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        # Renamed into place so a flush never picks up a half-written capture.
        os.replace(tmp, full)
        self.enforce_cap()
        return full

    def pending_blob_files(self):
        return [b["file"] for b in self._blob_list()]

    def take_batch(self, max_items, max_bytes):
        events = []
        files = []
        used = 0
        for segment in self._list_segments():
            if len(events) >= max_items:
                break
            if used + segment["bytes"] > max_bytes and events:
                break
            try:
                with open(segment["file"], encoding="utf8") as fh:
                    text = fh.read()
            except OSError:
                continue
            lines = [line for line in text.split("\n") if line.strip()]
            consumed = 0
            for index, line in enumerate(lines):
                if len(events) >= max_items:
                    break
                try:
                    events.append(json.loads(line))
                except ValueError:
                    consumed = index + 1
                    continue
                consumed = index + 1
            if consumed >= len(lines):
                files.append({"file": segment["file"], "bytes": segment["bytes"],
                              "count": len(events)})
            else:
                # Partially consumed segment: rewrite the remainder in place. Re-serialising from
                # the surviving lines is what stops a corrupt line from being written back forever.
                remainder = lines[consumed:]
                try:
                    with open(segment["file"], "w", encoding="utf8") as fh:
                        fh.write("\n".join(remainder) + "\n" if remainder else "")
                    if self._current and self._current["file"] == segment["file"]:
                        self._current["bytes"] = os.path.getsize(segment["file"])
                except OSError as err:
                    self._warn(f"segment rewrite: {err}")
            used += sum(len(line.encode("utf8")) + 1 for line in lines[:consumed])
        return {"events": events, "files": files, "bytes": used}

    def discard_files(self, files):
        for entry in files:
            self._close_if_needed(entry["file"])
        for entry in files:
            try:
                os.unlink(entry["file"])
            except OSError:
                pass
        if self._current and not os.path.exists(self._current["file"]):
            try:
                os.close(self._current["fd"])
            except OSError:
                pass
            self._current = None

    def mark_dropped(self, count):
        self.state["dropped"] += count
        self._save_meta()

    def dropped(self):
        return self.state["dropped"]

    def acknowledge_dropped(self):
        dropped = self.state["dropped"]
        self.state["dropped"] = 0
        self._save_meta()
        return dropped

    def close(self):
        if self._current:
            try:
                os.close(self._current["fd"])
            except OSError:
                pass
            self._current = None
