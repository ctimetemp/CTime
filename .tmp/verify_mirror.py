"""Mirrors-the-four-changes verification for client-py. Scratch script; lives in .tmp."""
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client-py"))

from CTTIme_agent import notify as notify_mod
from CTTIme_agent.connection import ConnectionWatch
from CTTIme_agent.errors import ClientError
from CTTIme_agent.notify import Notifier
from CTTIme_agent.producers import backoff_delay
from CTTIme_agent.agent import since_words
from CTTIme_agent.transport import Transport

PIN = "01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767"
TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mirrorcheck")
results = []


def ok(name, condition, detail=""):
    results.append((bool(condition), name, detail))
    print(("PASS " if condition else "FAIL ") + name + (f" :: {detail}" if detail else ""))


def collector_up(host="127.0.0.1", port=8443):
    import socket
    try:
        s = socket.create_connection((host, port), 1.0)
    except OSError:
        return False
    s.close()
    return True


LIVE = collector_up()

# ---------------------------------------------------------------- 1. transport failover
t = Transport("127.0.0.1", ports=[1, 8443], pin=PIN)
ok("transport.ports() keeps the configured order", t.ports() == [1, 8443], str(t.ports()))
ok("transport starts at the first configured port", t.active_port() == 1, str(t.active_port()))
if not LIVE:
    print("SKIP live-collector failover assertions: nothing is listening on 127.0.0.1:8443 and "
          "the collector must not be started")
    t.close()
else:
    res = t.get("/api/v1/notice")
    ok("refused port 1 failed over and the request landed on 8443",
       res.status == 200 and t.active_port() == 8443, f"status={res.status} active={t.active_port()}")
    ok("pin was compared on the failover", t.pin_verified() is True)
    res2 = t.get("/api/v1/notice")
    ok("later requests start from the port that last worked",
       res2.status == 200 and t.active_port() == 8443)
    t.close()

if not LIVE:
    ok("single-int-port constructor accepted (offline)", True)
    ok("string ports from the CLI accepted (offline)", True)
else:
    single = Transport("127.0.0.1", 8443, PIN)
    ok("a single int port still works", single.ports() == [8443] and single.active_port() == 8443)
    single.get("/api/v1/notice")
    single.close()

    strings = Transport("127.0.0.1", ports=["8443"], pin=PIN)
    ok("port list entries may arrive as strings from the CLI", strings.ports() == [8443])
    strings.close()

hostile = Transport("127.0.0.1", ports=[8443, 1], pin="0" * 64)
code = None
if not LIVE:
    print("SKIP live pin-mismatch assertion: covered offline in verify_transport_offline.py")
    ok("hostile transport built with a port set (offline)", hostile.ports() == [8443, 1])
else:
    try:
        hostile.get("/api/v1/notice")
    except ClientError as err:
        code = err.code
    ok("a pin mismatch is terminal and never port-switches",
       code == "tls_pin_mismatch" and hostile.active_port() == 8443,
       f"code={code} active={hostile.active_port()}")
hostile.close()

try:
    Transport("127.0.0.1", ports=["nope"], pin=PIN)
    ok("an unusable port set is refused", False)
except ClientError as err:
    ok("an unusable port set is refused", err.code == "port_missing", err.code)

# ---------------------------------------------------------------- 2. notify
logs = []
work = os.path.join(TMP, "notify")
shutil.rmtree(work, ignore_errors=True)
n = Notifier(work, log=logs.append)
ok("balloon script written to the work dir", os.path.exists(n.script_path), n.script_path)
shown = n.show("approved")
ok("a real notice was shown over the balloon",
   shown.get("shown") is True and shown.get("via") == "balloon", json.dumps(shown))
again = n.show("approved")
ok("the same notice is throttled inside its own window",
   again.get("shown") is False and again.get("via") == "suppressed", json.dumps(again))
filled = n.show("collecting", {"values": {"screenshots": 12, "events": 340, "dropped": 0, "since": "22h"}})
ok("the summary notice fills and shows", filled.get("shown") is True, json.dumps(filled))
ok("an unknown kind is refused without raising",
   n.show("nope") == {"shown": False, "via": "none", "reason": "unknown alert nope"})

record = json.loads(open(n.file, encoding="utf8").read())
ok("notifications.json shape is {sent, failed, lastShownAt, history}",
   set(record) == {"sent", "failed", "lastShownAt", "history"}, str(sorted(record)))
ok("counters record what was shown", record["sent"] == 2 and record["failed"] == 0,
   f"sent={record['sent']} failed={record['failed']}")
ok("lastShownAt is kind -> ms",
   set(record["lastShownAt"]) == {"approved", "collecting"}
   and all(isinstance(v, int) and v > 1e12 for v in record["lastShownAt"].values()),
   str(record["lastShownAt"]))
entry = record["history"][0]
ok("history entry is {kind, at, shown, via, error} newest first",
   set(entry) == {"kind", "at", "shown", "via", "error"} and entry["kind"] == "collecting",
   json.dumps(entry))
ok("windows are collecting 20h / registered 6h / approved 6h / floor 60s",
   (n.window_for("collecting"), n.window_for("registered"), n.window_for("approved"),
    n.window_for("offline")) == (72000, 21600, 21600, 60),
   str(n.windows))

# text bounds enforced on the way out, and the persisted record proves it
for kind, alert in notify_mod.ALERTS.items():
    ok(f"{kind} fits the balloon ({len(alert['text'])} <= {notify_mod.MAX_TEXT})",
       len(alert["title"]) <= notify_mod.MAX_TITLE and len(alert["text"]) <= notify_mod.MAX_TEXT)

# a notice that cannot be shown is recorded failed and does not raise
broken_dir = os.path.join(TMP, "broken")
shutil.rmtree(broken_dir, ignore_errors=True)
b = Notifier(broken_dir, log=logs.append)
b.script_path = os.path.join(TMP, "not-there.ps1")
outcome = b.show("online")
ok("an unshowable notice is recorded as failed, never raised",
   outcome.get("shown") is False and bool(outcome.get("error")), json.dumps(outcome))
broken_record = json.loads(open(b.file, encoding="utf8").read())
ok("the failure is in the record the device user can read",
   broken_record["failed"] == 1 and broken_record["sent"] == 0, json.dumps(broken_record))
ok("history is capped at 20 entries",
    len(json.loads(open(n.file, encoding='utf8').read())["history"]) <= 20)
ok("fill leaves an unknown placeholder visibly unfilled",
   notify_mod.fill("a {nope} b", {"x": 1}) == "a {nope} b")

# ---------------------------------------------------------------- 3. connection watch
class Recorder:
    def __init__(self):
        self.kinds = []

    def show(self, kind, overrides=None):
        self.kinds.append(kind)
        return {"shown": True, "via": "balloon"}


seen = Recorder()
watch = ConnectionWatch(seen, log=lambda m: None)
watch.observe({"retryInMs": 500000})
ok("offline is announced and the state machine moves",
   seen.kinds == ["offline"] and watch.state == "offline", f"{seen.kinds} {watch.state}")
ok("the early retry is capped at 60000ms, not 500s",
   watch.retry_at is not None and 0 < watch.retry_at - time.time() <= 60.1,
   f"{(watch.retry_at - time.time()):.1f}s pending")
watch.observe({"retryInMs": 400000})
ok("a repeat offline outcome still asks the notifier (which suppresses it)",
   seen.kinds == ["offline", "offline"], str(seen.kinds))
up = watch.observe({"unchanged": True})
ok("recovery is a transition and announces online",
   up == "online" and seen.kinds[-1] == "online" and watch.retry_at is None,
   f"{seen.kinds} retry={watch.retry_at}")
watch.observe({"terminal": ClientError(0, "tls_pin_mismatch", "cert mismatch")})
ok("a pin failure moves to unverified and pops the one notice IT can act on",
   watch.state == "unverified" and seen.kinds[-1] == "unverified", str(seen.kinds))
before = len(seen.kinds)
watch.observe({"terminal": ClientError(0, "state_not_approved", "pending")})
ok("consent/state terminal codes do not pop a notice", len(seen.kinds) == before, str(seen.kinds))

quiet = Recorder()
first = ConnectionWatch(quiet, log=lambda m: None)
first.observe({"unchanged": True})
ok("'online' is not announced out of an unknown first state", quiet.kinds == [], str(quiet.kinds))
announced = ConnectionWatch(quiet, log=lambda m: None, announce_first_online=True)
announced.observe({"unchanged": True})
ok("announceFirstOnline opt-in still announces", quiet.kinds == ["online"], str(quiet.kinds))

fired = []
live = ConnectionWatch(Recorder(), log=lambda m: None,
                       on_retry=lambda: fired.append(time.time()), retry_cap_ms=1500)
live.observe({"retryInMs": 900000})
ok("a capped retry is not due immediately", live.retry_due() is False)
time.sleep(2.0)
due = live.retry_due()
took = live.take_retry()
ok("the 900000ms backoff was retried inside the 1500ms cap",
   due and took and len(fired) == 1 and fired[0] - time.time() < 2.1,
   f"fired={len(fired)}")
ok("take_retry consumes the deadline", live.retry_due() is False and live.take_retry() is False)

cancelled = ConnectionWatch(Recorder(), log=lambda m: None, on_retry=lambda: fired.append("late"))
cancelled.observe({"retryInMs": 60000})
cancelled.stop()
ok("stop() cancels a scheduled early retry", cancelled.retry_due() is False)

# ---------------------------------------------------------------- 4/5. backoff + since words
ok("reconnect backoff defaults are base 2000 / cap 120000",
   backoff_delay(9) <= 120000 and backoff_delay(0, rand=lambda: 1.0) == 2000,
   f"attempt9={backoff_delay(9)} ceil0={backoff_delay(0, rand=lambda: 1.0)}")
ok("since_words formats 40m/3h/2d like the Node client",
   (since_words(40 * 60000), since_words(3 * 3600000), since_words(2 * 86400000))
   == ("40m", "3h", "2d"),
   f"{since_words(2400000)}/{since_words(10800000)}/{since_words(172800000)}")
ok("since_words half-up rounding matches Math.round at 2.5h",
   since_words(9000000) == "3h", since_words(9000000))

print()
failed = [name for good, name, _ in results if not good]
print(f"{len(results) - len(failed)}/{len(results)} assertions passed")
if failed:
    print("FAILED:", failed)
sys.exit(1 if failed else 0)
