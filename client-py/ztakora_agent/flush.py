import json
import os
import re

from .clock import iso_from_epoch
from .errors import is_retryable
from .producers import backoff_delay

BLOB_EVENT_RE = re.compile(r"^[0-9a-z]+-([0-9a-f-]{36})$", re.IGNORECASE)


def _event_id_from_blob(file):
    """The blob name is `<time36>-<uuid>.png`; the event id is recovered from it rather than kept
    in a sidecar, so a crash between writing and flushing cannot orphan an unattributable image."""
    base = os.path.basename(file)
    if base.endswith(".png"):
        base = base[:-4]
    match = BLOB_EVENT_RE.match(base)
    return match.group(1) if match else base


def _estimate_compressed(events):
    # The gzip ratio on NDJSON is high and variable; an order-of-magnitude estimate is enough for a
    # traffic gauge, and the real number is bounded by what the server counted.
    return round(sum(len(json.dumps(e)) + 1 for e in events) / 4)


class Flusher:
    """The flush loop is the only thing in the client that touches the network. Producers write to
    the spool and return; if the collector is down, the device notices nothing except a growing
    spool."""

    def __init__(self, transport, spool, policy, device_id, token, log, on_policy=None,
                 blob_meta=None):
        self.transport = transport
        self.spool = spool
        self.policy = policy
        self.device_id = device_id
        self.token = token
        self.log = log
        self.on_policy = on_policy
        self.blob_meta = blob_meta if blob_meta is not None else {}
        self.bytes_sent = 0
        self.attempt = {"heartbeat": 0, "batch": 0, "shot": 0}
        # What this process has actually handed to the collector. The device user's daily notice
        # quotes these numbers, so they are counted where the bytes are counted rather than guessed
        # later.
        self._counts = {"events": 0, "screenshots": 0, "batches": 0}
        self.last_error = None

    def counts(self):
        return dict(self._counts)

    def add_bytes(self, n):
        self.bytes_sent += n

    def _with_backoff(self, kind, work):
        try:
            out = work()
            self.attempt[kind] = 0
            return out
        except Exception as err:
            self.last_error = err
            if not is_retryable(err):
                # A terminal code (422 content rejection, 401 bad token, pin mismatch) must not be
                # retried at all: retrying would re-send the payload that was refused.
                self.log(f"{kind} terminal: {getattr(err, 'code', 'internal')} "
                         f"{getattr(err, 'detail', '') or err}")
                return {"terminal": err}
            # Base 2s, ceiling 2min -- the defaults in backoff_delay are the agent's reconnect
            # policy, kept in one place so the ceiling a device sleeps under is the same number the
            # tests assert. A server-supplied retry_after is honoured but likewise capped: a long
            # outage must not end with the agent asleep a quarter of an hour after the collector is
            # back.
            retry_after = getattr(err, "retry_after", None)
            if retry_after:
                delay = min(float(retry_after) * 1000, 300000)
            else:
                delay = backoff_delay(self.attempt[kind])
                self.attempt[kind] += 1
            self.log(f"{kind} retryable: {getattr(err, 'code', None) or err}; "
                     f"backing off {round(delay / 1000)}s")
            return {"retryInMs": delay}

    def heartbeat(self):
        totals = self.spool.totals()

        def work():
            response = self.transport.post_json("/api/v1/heartbeat", {
                "policy_etag": self.policy.etag,
                "spool_bytes": totals["bytes"],
                "spool_dropped": self.spool.dropped(),
                "bytes_sent": self.bytes_sent,
            }, self.token.headers())
            if response.status == 204:
                return {"unchanged": True}
            body = response.json()
            applied = self.policy.apply_diff(body.get("changed"), body.get("removed"),
                                            response.headers.get("x-policy-etag") or self.policy.etag)
            if (body.get("changed") or body.get("removed")) and self.on_policy:
                self.on_policy(applied)
            return {"changed": body}

        return self._with_backoff("heartbeat", work)

    def flush_batch(self):
        """Chunks until the spool is drained or a budget-bound request has been accepted, so the
        post-approval backfill can never become one enormous request."""
        values = self.policy.values
        sent = []
        for _guard in range(200):
            batch = self.spool.take_batch(values["batch_max_items"], values["batch_max_bytes"])
            events = batch["events"]
            if not events:
                return {"drained": True, "sent": sent}

            def work():
                response = self.transport.post_gzip_ndjson("/api/v1/batch", events, {
                    **self.token.headers(), "x-device-id": self.device_id()})
                return response.json()

            result = self._with_backoff("batch", work)
            terminal = result.get("terminal") if isinstance(result, dict) else None
            if terminal is not None:
                if getattr(terminal, "code", None) == "content_field_forbidden":
                    # The server refused the whole segment. Dropping it is the only correct
                    # response: keeping it would re-offer clipboard content on every retry.
                    self.spool.discard_files(batch["files"])
                    self.spool.mark_dropped(len(events))
                    self.log(f"dropped {len(events)} events after content rejection")
                return {"stopped": getattr(terminal, "code", "terminal"), "sent": sent}
            if isinstance(result, dict) and "retryInMs" in result:
                return {"retryInMs": result["retryInMs"], "sent": sent}
            self.bytes_sent += _estimate_compressed(events)
            self._counts["events"] += len(events)
            self._counts["batches"] += 1
            # Accepted or duplicate, the server has the events either way: at-least-once plus
            # event_id uniqueness means the segment can go.
            self.spool.discard_files(batch["files"])
            sent.append(result)
            if len(events) < values["batch_max_items"]:
                return {"drained": True, "sent": sent}
        return {"hitGuard": True, "sent": sent}

    def flush_screenshots(self):
        """One image per request, oldest first, each independently idempotent on its event id."""
        values = self.policy.values
        uploaded = 0
        for file in self.spool.pending_blob_files():
            try:
                size = os.path.getsize(file)
            except OSError:
                continue
            if size > values["screenshot_max_bytes"]:
                self.log(f"blob {size}b over cap; dropping")
                os.unlink(file)
                self.spool.mark_dropped(1)
                continue
            captured_at = iso_from_epoch(os.path.getmtime(file))
            event_id = _event_id_from_blob(file)
            meta = self.blob_meta.get(file, {})

            def work():
                response = self.transport.post_png(
                    "/api/v1/screenshots", file,
                    {**self.token.headers(), "x-event-id": event_id,
                     "x-device-id": self.device_id(), "x-captured-at": captured_at},
                    sha256=meta.get("sha256"), phash=meta.get("phash"))
                return {"status": response.status, "body": response.json()}

            result = self._with_backoff("shot", work)
            if isinstance(result, dict) and ("terminal" in result or "retryInMs" in result):
                terminal = result.get("terminal")
                return {"uploaded": uploaded,
                        "stopped": getattr(terminal, "code", "backoff") if terminal else "backoff"}
            self.bytes_sent += size
            self._counts["screenshots"] += 1
            try:
                os.unlink(file)
            except OSError:
                pass
            self.blob_meta.pop(file, None)
            uploaded += 1
        return {"uploaded": uploaded}

    def cycle(self):
        return {"hb": self.heartbeat(), "batch": self.flush_batch(),
                "shots": self.flush_screenshots(), "lastError": self.last_error}

    def state(self):
        return {"attempt": dict(self.attempt),
                "lastError": None if self.last_error is None else {
                    "code": getattr(self.last_error, "code", "internal"),
                    "detail": getattr(self.last_error, "detail", str(self.last_error))}}
