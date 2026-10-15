"""Turns what the flush loop learns about the collector into two things the device user can see: a
notice on their screen when the link changes state, and an early retry when the network comes back
instead of waiting for the next scheduled heartbeat.

Mirrors ``agent/lib/connection.js``. The state machine has one input -- the outcome of a heartbeat,
which is the only request the agent makes on a timer whether or not there is anything to send. That
keeps "am I connected" and "do I have data" separate, which is the distinction the offline spool
depends on.

The single-threaded loop has no timer to set, so an early retry is a deadline the scheduler wakes
for; ``retry_at`` is ``None`` when nothing is pending.
"""


import time


class ConnectionWatch:
    def __init__(self, notifier, log, on_retry=None, retry_cap_ms=60000,
                 announce_first_online=False):
        self.notifier = notifier
        self.log = log
        self.on_retry = on_retry
        self.retry_cap_ms = retry_cap_ms
        self.announce_first_online = announce_first_online
        self.state = "unknown"
        self.transitions = 0
        self.retry_at = None

    def _set_state(self, next_state, reason=None):
        if next_state == self.state:
            return None
        previous = self.state
        self.state = next_state
        self.transitions += 1
        self.log(f"connection {previous} -> {next_state}"
                 + (f" ({reason})" if reason else ""))
        return previous

    def cancel_retry(self):
        self.retry_at = None

    def schedule_retry(self, delay_ms):
        # The retry a backoff asks for is capped: a long outage should not end with the agent
        # sleeping for fifteen minutes after the collector is already back. The cost is one extra
        # unanswered request per minute, which is nothing against the spool it protects.
        wait = max(1000.0, min(float(delay_ms), self.retry_cap_ms))
        self.retry_at = time.time() + wait / 1000.0

    def retry_due(self, now=None):
        return self.retry_at is not None and (time.time() if now is None else now) >= self.retry_at

    def take_retry(self):
        """Called by the scheduler once the deadline has passed. Clears it and returns whether one
        was pending; the heartbeat itself is the caller's, so a watch that also ran one would
        double-tick."""
        if self.retry_at is None:
            return False
        self.retry_at = None
        if self.on_retry is not None:
            try:
                self.on_retry()
            except Exception as err:  # a retry that throws must not take the loop down
                self.log(f"retry tick: {getattr(err, 'code', None) or err}")
        return True

    def observe(self, res):
        # `None` means no heartbeat outcome was produced, which is not the same as a successful one.
        # An empty dict is a success: on the Node client `{}` is truthy and moves the state to
        # online, and a device that read the collector but got nothing back is connected.
        if res is None:
            return self.state
        terminal = res.get("terminal") if isinstance(res, dict) else None
        if terminal is not None:
            code = getattr(terminal, "code", None)
            # A pin mismatch is the one failure the person at the keyboard can usefully act on: it
            # means something other than the collector answered, and nothing will be uploaded until
            # IT fixes it. It is also repeatable -- an attacker or a misconfigured proxy on the path
            # does not get to be announced once and then go quiet.
            if code in ("tls_pin_mismatch", "tls_no_certificate"):
                self._set_state("unverified", code)
                self.notifier.show("unverified")
            # Other terminal codes are this device's consent or token state, not the link. The
            # dashboard and `status` are where those are visible; a balloon about them would tell
            # the user nothing they have not already answered.
            self.cancel_retry()
            return self.state
        if isinstance(res, dict) and "retryInMs" in res:
            self._set_state("offline", res.get("code") or "unreachable")
            self.notifier.show("offline")
            self.schedule_retry(res["retryInMs"])
            return self.state
        previous = self._set_state("online")
        self.cancel_retry()
        if previous and previous != "unknown":
            self.notifier.show("online")
        elif previous == "unknown" and self.announce_first_online:
            self.notifier.show("online")
        return self.state

    def stop(self):
        self.cancel_retry()
