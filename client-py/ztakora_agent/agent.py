import json
import os
import re
import sys
import time

from .clock import now_iso
from .connection import ConnectionWatch
from .console import hide_resident_console
from .disclosure import write_disclosure_config
from .errors import ClientError
from .flush import Flusher
from .identity import device_fingerprint
from .notify import Notifier
from .policy import PolicyState
from .producers import Producers
from .samplers import Capturer, ClipboardSampler
from .spool import Spool
from .state import (device_identity, ensure_layout, paths, read_json_file, resolve_state_dir,
                    write_json_file)
from .token import TokenHolder, open_token, seal_token
from .transport import Transport
from . import AGENT_VERSION

PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000"
# Long base64-ish runs in a log line are almost always a token or a hash of device content.
REDACT_RE = re.compile(r"[A-Za-z0-9+/=]{40,}")

# How often a resident agent re-reads its gates while they are still shut. The scheduled task
# fires at logon and on a repetition, so this is the mechanism that picks up an acknowledgment
# typed in another window and an approval clicked in the dashboard.
GATE_RECHECK_SECONDS = 30

# These reasons are decisions about the device, not gates waiting to open, so waiting on them
# would be pretending. `token_issuance_missed` needs an admin to rotate the token, and `declined`
# is the device user's own answer.
TERMINAL_STOPS = frozenset({"declined", "rejected", "revoked", "token_issuance_missed"})


def _js_round(value):
    """Math.round(): half up, not Python's half-to-even. The span in a notice the device user reads
    has to be the same number the Node client prints, and 2.5h is 3h there."""
    return int(value + 0.5)


def since_words(ms):
    """"3h", "2d", "40m" -- the span a summary notice quotes, kept short because it goes inside a
    balloon that clips at 240 characters."""
    secs = max(0, _js_round(ms / 1000))
    if secs < 5400:
        return f"{max(1, _js_round(secs / 60))}m"
    if secs < 172800:
        return f"{_js_round(secs / 3600)}h"
    return f"{_js_round(secs / 86400)}d"


def make_logger(file, verbose=False):
    def log(message):
        text = message if isinstance(message, str) else json.dumps(message)
        # Anything reaching this line is visible to the device user, so it is a disclosure surface:
        # no payload content, no token, no clipboard text, ever.
        line = f"{now_iso()} {REDACT_RE.sub('[redacted-long-token]', text)}\n"
        try:
            with open(file, "a", encoding="utf8") as fh:
                fh.write(line)
        except OSError:
            pass
        if verbose:
            sys.stdout.write(line)
            sys.stdout.flush()
    return log


def print_notice(notice):
    bar = "=" * 72
    sys.stdout.write(f"\n{bar}\nMONITORING NOTICE (version {notice.get('version')})\n{bar}\n")
    sys.stdout.write(f"{notice.get('text')}\n{bar}\n")
    sys.stdout.write(f"This device would collect: {', '.join(notice.get('collects') or [])}\n")
    sys.stdout.write("Declining stops all collection and records nothing.\n\n")
    sys.stdout.flush()


class Scheduler:
    """One loop, one thread. Intervals are derived from the live policy on every (re)start, which
    is what lets a dashboard edit take effect within one heartbeat cycle without restarting."""

    def __init__(self, policy, spool, producers, flusher, log, watch=None, notifier=None):
        self.policy = policy
        self.spool = spool
        self.producers = producers
        self.flusher = flusher
        self.log = log
        self.watch = watch
        self.notifier = notifier
        # The span the hourly summary notice quotes is measured from here, not from start(): a
        # policy change that retimes the loop does not restart the agent's clock.
        self.started_at = time.time()
        self.intervals = {}
        self.due = {}
        self.stop_requested = False

    def _intervals_for(self, values):
        return {
            "heartbeat": max(30, values["heartbeat_interval_seconds"]),
            "screenshot": max(1, values["screenshot_interval_minutes"]) * 60,
            "clipboard": max(15, values["clipboard_sample_seconds"] or 60),
            "extensions": 60,
            "spool_cap": 300,
            "user_summary": 3600,
        }

    def start(self, values):
        self.intervals = self._intervals_for(values)
        base = time.time()
        self.due = {job: base + seconds for job, seconds in self.intervals.items()}

    def retime(self, values):
        if not self.due:
            return
        # As on the Node client, a retime goes through stop(), and stop() cancels a pending early
        # retry: the rescheduled heartbeat is due anyway, so the retry would only double-tick.
        if self.watch:
            self.watch.stop()
        self.start(values)

    def stop(self):
        self.stop_requested = True
        # A retry scheduled between ticks would outlive stop() and fire a request from an agent that
        # has already closed its transport and spool.
        if self.watch:
            self.watch.stop()

    def user_summary(self):
        """A standing statement that collection is happening, once an hour. The notifier throttles
        it to roughly one notice a day, and the numbers are the flusher's own counters rather than a
        re-derivation, so what the user is told matches what the agent sent."""
        if not self.notifier:
            return
        counts = self.flusher.counts()
        if counts["events"] + counts["screenshots"] == 0:
            return
        self.notifier.show("collecting", {"values": {
            "screenshots": counts["screenshots"],
            "events": counts["events"],
            "dropped": self.spool.dropped(),
            "since": since_words((time.time() - self.started_at) * 1000),
        }})

    def _tick(self, job):
        if job == "heartbeat":
            result = self.flusher.heartbeat()
            # The heartbeat is the watch's only input: it is the one request a resident agent makes
            # whether or not there is anything to send.
            if self.watch:
                self.watch.observe(result)
            if isinstance(result, dict) and result.get("changed"):
                self.log("heartbeat applied policy changes")
            self.flusher.flush_batch()
            self.flusher.flush_screenshots()
        elif job == "screenshot":
            result = self.producers.screenshot_tick()
            if result.get("captured"):
                self.flusher.flush_screenshots()
        elif job == "clipboard":
            self.producers.clipboard_tick()
        elif job == "extensions":
            self.producers.extension_tick()
        elif job == "spool_cap":
            self.spool.enforce_cap()
        elif job == "user_summary":
            self.user_summary()

    def run(self):
        self.stop_requested = False
        try:
            while not self.stop_requested:
                now = time.time()
                job, when = min(self.due.items(), key=lambda item: item[1])
                if self.watch and self.watch.retry_due():
                    # The link came back before the next scheduled tick: run one heartbeat now rather
                    # than leaving a device that regained the collector silent until then. The watch
                    # owns and clears the deadline (capped at retry_cap_ms), and the scheduled timer
                    # is deliberately left where it was, as on the Node client.
                    self.watch.take_retry()
                    try:
                        self._tick("heartbeat")
                    except Exception as err:
                        self.log(f"heartbeat tick failed: {getattr(err, 'code', None) or err}")
                    continue
                if when > now:
                    # Short slices keep shutdown responsive without a second thread.
                    time.sleep(min(when - now, 1.0))
                    continue
                self.due[job] = time.time() + self.intervals[job]
                try:
                    self._tick(job)
                except Exception as err:  # a failed tick must not end the agent
                    self.log(f"{job} tick failed: {getattr(err, 'code', None) or err}")
        except KeyboardInterrupt:
            pass
        finally:
            self.stop_requested = True
            if self.watch:
                self.watch.stop()


class Agent:
    def __init__(self, opts):
        self.opts = opts
        self.state_dir = resolve_state_dir(opts.get("state_dir"))
        self.p = paths(self.state_dir)
        ensure_layout(self.p)
        self.log = make_logger(self.p["log"], opts.get("verbose"))
        self.identity = device_identity()
        self.ident = device_fingerprint(self.state_dir)
        self.stored = read_json_file(self.p["identity"], {}) or {}

        # Every listener in the port set presents the same certificate and the same router, so the
        # list is availability, not identity: the pin check is unchanged whichever port answers.
        self.transport = Transport(opts["host"], pin=opts["pin"],
                                   ports=opts.get("ports") or [opts.get("port", 8443)])
        self.policy = PolicyState(self.p["policy"], on_warn=self.log)
        self.spool = Spool(self.p["spool"], self.policy.values["spool_max_bytes"],
                           on_warn=self.log)
        self.token = TokenHolder(open_token(self.p["token"]))
        self.capturer = Capturer(self.p["pending"], on_warn=self.log)
        self.clipboard_sampler = ClipboardSampler(self.p["pending"], on_warn=self.log)
        # Producers is injected with callables, the same shape the Node port uses, so a Capturer
        # instance would be silently non-callable at the tick instead of loudly wrong here.
        self.producers = Producers(self.spool, self.policy, self.device_id, self.capturer.capture,
                                   self.clipboard_sampler, self.log)
        self.producers.load_gists(self.state_dir)

        self.scheduler = None
        self.flusher = Flusher(self.transport, self.spool, self.policy, self.device_id, self.token,
                               self.log, on_policy=self._on_policy,
                               blob_meta=self.producers.blob_meta)
        # The device user is told, on their own screen, when the link to the collector changes. It is
        # wired to the heartbeat outcome because that is the one request a resident agent makes
        # whether or not there is anything to send, so "cannot reach the collector" and "nothing to
        # report" stay distinct. one-shot and check never reach here: a verification command must not
        # pop a balloon.
        self.notifier = Notifier(self.p["pending"], log=self.log)
        # No on_retry callback: this agent has one thread, so the watch hands the scheduler a capped
        # deadline and the loop runs the heartbeat when it arrives instead of being called back.
        self.watch = ConnectionWatch(self.notifier, log=self.log)
        self.scheduler = Scheduler(self.policy, self.spool, self.producers, self.flusher, self.log,
                                   watch=self.watch, notifier=self.notifier)
        # Set by stop() and by Ctrl-C. The gate wait and the collection loop both check it, so a
        # device that has been told to stop stops within a second rather than at the next tick.
        self.stop_requested = False
        self.prompted = False
        self._write_disclosure()

    def stop(self):
        self.stop_requested = True
        if self.scheduler:
            self.scheduler.stop()

    def _sleep(self, seconds):
        """Sleep in short slices. Returns True if a stop landed during the sleep, so the caller
        can leave instead of doing one more check against a collector nobody is waiting for."""
        deadline = time.time() + seconds
        try:
            while not self.stop_requested and time.time() < deadline:
                time.sleep(min(1.0, max(0.05, deadline - time.time())))
        except KeyboardInterrupt:
            self.stop_requested = True
        return self.stop_requested

    def device_id(self):
        return self.stored.get("device_id") or PLACEHOLDER_UUID

    def _on_policy(self, _applied=None):
        # The spool cap is server-owned too, so a dashboard edit that lowers it applies here.
        self.spool.max_bytes = self.policy.values["spool_max_bytes"]
        self.spool.enforce_cap()
        if self.scheduler:
            self.scheduler.retime(self.policy.values)
        self._write_disclosure()

    def _write_disclosure(self):
        write_disclosure_config(self.p, self.policy, self.opts, self.state_dir, self.ident)

    def refresh_config(self):
        headers = {**self.token.headers()}
        if self.policy.etag:
            headers["if-none-match"] = self.policy.etag
        try:
            response = self.transport.get("/api/v1/config", headers)
            if response.status == 304:
                return self.policy.values
            return self.policy.replace(response.json(), response.headers.get("etag"))
        except ClientError as err:
            self.log(f"config fetch failed: {getattr(err, 'code', None) or err}")
            return None
        except ValueError:
            self.log("config fetch failed: unparseable policy document")
            return None

    def check_approval(self):
        try:
            body = self.transport.get(
                f"/api/v1/enroll/status?fingerprint={self.ident['fingerprint']}").json()
        except (ClientError, ValueError) as err:
            if getattr(err, "code", None) == "unknown_device":
                return {"ready": False, "reason": "not_enrolled"}
            # The detail carries the certificate hash actually presented, which is the difference
            # between "this collector was reinstalled" and "something else is answering on it".
            self.log("approval check failed: %s %s" % (
                getattr(err, "code", None) or err, getattr(err, "detail", "") or "").strip())
            return {"ready": False, "reason": "check_failed"}
        if body.get("token"):
            try:
                seal_token(body["token"], self.p["token"])
            except (RuntimeError, OSError) as err:
                self.log(f"approval check failed: could not seal token: {err}")
                return {"ready": False, "reason": "check_failed"}
            self.token.set(body["token"])
            self.log("approved; token sealed into token.bin with DPAPI CurrentUser")
            return {"ready": True}
        if body.get("state") == "approved":
            unsealed = open_token(self.p["token"])
            if unsealed:
                self.token.set(unsealed)
                return {"ready": True}
            # The token exists server-side and was already delivered once; it cannot be fetched
            # again. An admin has to rotate it.
            return {"ready": False, "reason": "token_issuance_missed"}
        return {"ready": False, "reason": body.get("state")}

    def fetch_notice(self):
        try:
            return self.transport.get("/api/v1/notice").json()
        except (ClientError, ValueError):
            return None

    def ensure_enrolled(self):
        """Nothing is collected before enrollment completes, so an unapproved device produces no
        data rather than data that is deleted later."""
        direct = self.check_approval()
        if direct["ready"] or direct["reason"] != "not_enrolled":
            return direct

        notice = self.fetch_notice()
        if not notice:
            return {"ready": False, "reason": "notice_unavailable"}

        declined = os.path.join(self.p["root"], "DECLINED.txt")
        # A decline recorded on this device is the device user's own answer, and it sticks: a
        # scripted acknowledgment from anywhere else cannot walk it back. Only the person typing
        # their name into this notice, in their own window, can change their mind.
        if os.path.exists(declined) and not self.opts.get("interactive"):
            self.log("declined on this device earlier: not enrolling")
            return {"ready": False, "reason": "declined"}

        acknowledged_by = self.opts.get("acknowledge_by")
        if not acknowledged_by:
            # Asked once. The resident loop comes back here every recheck, and a second notice on
            # the same terminal reads as harassment rather than as a gate; with no stdin at all
            # (a task started without a window) input() would raise and take the agent down.
            if not self.opts.get("interactive") or self.prompted:
                return {"ready": False, "reason": "consent_required"}
            print_notice(notice)
            self.prompted = True
            try:
                acknowledged_by = input('Type your name to acknowledge, or "no" to decline: ')
            except EOFError:
                self.log("acknowledgment needs a window of your own: run with --interactive")
                return {"ready": False, "reason": "consent_required"}
        elif self.opts.get("show_notice", True):
            # A scripted acknowledgment is shown the wording it is acknowledging.
            print_notice(notice)

        name = str(acknowledged_by or "").strip()
        if name == "" or re.fullmatch(r"no", name, re.IGNORECASE):
            with open(os.path.join(self.p["root"], "DECLINED.txt"), "w", encoding="utf8") as fh:
                fh.write(f"Device user declined the monitoring notice at {now_iso()}.\n"
                         "No data has been collected from this device.\n")
            return {"ready": False, "reason": "declined"}

        try:
            body = self.transport.post_json("/api/v1/enroll", {
                "fingerprint": self.ident["fingerprint"],
                "hostname": self.identity["hostname"],
                "os_build": self.identity["os_build"],
                "device_user": self.identity["device_user"],
                "agent_version": AGENT_VERSION,
                "notice_version": notice["version"],
                "acknowledged_by": name,
                "acknowledged_at": now_iso(),
            }).json()
            # Updated in place so the first approved run attributes its own events, and persisted
            # so a restart keeps the same device row.
            self.stored.update({"device_id": body["device_id"],
                                "fingerprint": self.ident["fingerprint"],
                                "enrolled_at": now_iso()})
            write_json_file(self.p["identity"], self.stored)
            self.log(f"enrolled {body['device_id']} state={body['state']}")
            # Reaching this line with a decline on file means the device user just typed their own
            # name into the notice, which is the only thing that can reverse their earlier answer.
            if os.path.exists(declined):
                os.remove(declined)
        except (ClientError, ValueError) as err:
            detail = getattr(err, "detail", "") or err
            self.log(f"enroll failed: {getattr(err, 'code', 'internal')} {detail}")
            return {"ready": False, "reason": "enroll_failed"}
        gate = self.check_approval()
        # `registered` is announced only on the run that actually created the row, so a device that
        # reboots every morning does not tell the user it just registered every morning.
        return {**gate, "just_registered": True}

    def _shutdown(self):
        # A retry pending at shutdown would fire a request over a transport that is already closed.
        if self.watch:
            self.watch.stop()
        self.spool.close()
        self.transport.close()

    def run(self):
        one_shot = bool(self.opts.get("one_shot"))
        # --resident is what the scheduled task passes, and it is the only thing that suppresses the
        # console window. Someone running this by hand keeps their window -- that window is the
        # terminal they are typing in. The other exclusions are belt-and-braces for the same reason:
        # --interactive prints the notice and waits for a name, --verbose echoes the log, and
        # --acknowledge-by is meant to show someone the wording they are acknowledging on the device
        # user's behalf.
        resident = (self.opts.get("resident") is True and not one_shot
                    and not self.opts.get("interactive")
                    and not self.opts.get("verbose") and not self.opts.get("acknowledge_by"))
        if resident and hide_resident_console(self.log):
            self.log("window hidden: find this agent with schtasks /query, "
                     "Get-Process, or cli.py status")
        last_gate = None
        while True:
            enrolled = self.ensure_enrolled()
            if enrolled.get("just_registered") and not one_shot:
                self.notifier.show("registered")
            if enrolled["ready"]:
                break
            reason = enrolled["reason"]
            # The log is something the device user reads, so a reason is stated once rather than
            # every recheck.
            if reason != last_gate:
                self.log(f"not collecting: {reason}")
                last_gate = reason
            if one_shot or reason in TERMINAL_STOPS:
                # one-shot is a verification command: it reports the gate and leaves so a script
                # or a person can read the answer.
                self._shutdown()
                return {"status": reason}
            # Waiting rather than exiting matters: the task fires at logon and on its repetition,
            # so an agent that leaves here collects nothing until the next sign-in -- which can be
            # days after the user acknowledges the notice or an admin approves the device.
            # Nothing is captured while it waits, which is what the gate is for.
            if self._sleep(GATE_RECHECK_SECONDS):
                self._shutdown()
                return {"status": "stopped"}

        if one_shot:
            self.refresh_config()
            self.producers.extension_tick(force=True)
            self.producers.clipboard_tick()
            self.producers.screenshot_tick()
            result = self.flusher.cycle()
            totals = self.spool.totals()
            self._shutdown()
            return {"status": "one-shot complete",
                    "spool": {"bytes": totals["bytes"], "segments": totals["segments"],
                              "blobs": totals["blobs"]},
                    "dropped": self.spool.dropped(), "etag": self.policy.etag, "res": result}

        values = None
        while not values:
            values = self.refresh_config()
            if values:
                break
            # A device that cannot read its policy cannot know its own intervals, so it captures
            # nothing rather than guessing. It stays and retries, because the collector being down
            # for an hour is normal and a device that exits is indistinguishable from one that
            # was never installed.
            if self._sleep(GATE_RECHECK_SECONDS):
                self._shutdown()
                return {"status": "stopped"}
            self.log("policy still unreadable: waiting")

        self.producers.extension_tick(force=True)
        self.scheduler.start(values)
        # The gate is open and this device is reporting. This is the moment a person would want
        # stated out loud if they had to learn it from a document, so it is stated on their screen
        # instead.
        if not one_shot:
            self.notifier.show("approved")
        try:
            self.flusher.cycle()
        except Exception as err:
            self.log(f"first cycle: {getattr(err, 'code', None) or err}")
        self.log(f"agent running pid={os.getpid()} device={self.device_id()}")
        self.scheduler.run()
        self._shutdown()
        self.log("agent stopped")
        return {"status": "stopped"}

    def check(self):
        """Verifies connectivity, the certificate pin, the notice and the enrollment state without
        capturing or spooling anything. A failed transport is reported as a failure, not as a
        healthy-looking report with the fields left empty."""
        try:
            notice = self.transport.get("/api/v1/notice").json()
        except (ClientError, ValueError) as err:
            code = getattr(err, "code", "internal")
            detail = str(getattr(err, "detail", "") or err)[:200]
            self.scheduler.stop()
            self.log(f"check failed: {code} {detail}")
            self._shutdown()
            return {"status": "check_failed", "error": code, "detail": detail,
                    "pin_verified": self.transport.verified}
        approval = self.check_approval()
        self.scheduler.stop()
        totals = self.spool.totals()
        self._shutdown()
        return {
            "status": "check",
            # Static disclosure: which addresses this device was told to trust. Which one a request
            # actually landed on is a live fact, so it is reported separately. Each port is a full
            # URL: "https://host:8443, 8444" reads like one address with a port list attached to it,
            # and an operator pasting that into a browser gets a wrong-looking target.
            "collector": " or ".join(
                "https://{}:{}".format(self.opts["host"], port)
                for port in self.transport.ports()),
            "answering_on": self.transport.active_port(),
            "pin_verified": self.transport.verified,
            "notice_version": notice.get("version"),
            "notice_collects": notice.get("collects"),
            "enrollment": "approved" if approval["ready"] else approval["reason"],
            "collecting": approval["ready"],
            "device_id": self.stored.get("device_id"),
            "has_sealed_token": bool(self.token.present()),
            "spool": totals,
        }
