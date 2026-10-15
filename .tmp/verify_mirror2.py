"""Part 2 of the mirror check: CLI port list, probe verdicts, capture-reason logging, wiring."""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "client-py"))

from CTTIme_agent import probes
from CTTIme_agent.cli import parse_ports
from CTTIme_agent.disclosure import write_disclosure_config
from CTTIme_agent.notify import Notifier
from CTTIme_agent.policy import PolicyState
from CTTIme_agent.producers import Producers
from CTTIme_agent.samplers import Capturer
from CTTIme_agent.state import paths, resolve_state_dir

PIN = "01c647dd394181e596988d7ea4c18f8369aa0b08e4ba598de7dc68564a928767"
TMP = os.path.join(HERE, ".tmp", "mirrorcheck2")
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)
results = []


def ok(name, condition, detail=""):
    results.append((bool(condition), name, detail))
    print(("PASS " if condition else "FAIL ") + name + (f" :: {detail}" if detail else ""))


# ---- CLI accepts the comma list exactly like agent/cli.js
ok("--port 8443,9447 -> both ports in order", parse_ports("8443,9447") == [8443, 9447])
ok("--port 8443 -> single port", parse_ports("8443") == [8443])
ok("--port separator set matches node ([,;\\s]+)", parse_ports("8443; 9447 18443") == [8443, 9447, 18443])
ok("junk entries dropped at the CLI, order and duplicates kept (node cli.js does the same)",
   parse_ports("8443, no, 8443, 9447") == [8443, 8443, 9447])
from CTTIme_agent.transport import Transport  # noqa: E402
deduped = Transport("127.0.0.1", ports=[8443, 8443, 9447, 0, 70000], pin=PIN)
ok("the transport de-duplicates and range-filters the listener set",
   deduped.ports() == [8443, 9447], str(deduped.ports()))
deduped.close()
ok("empty is empty (the transport refuses it)", parse_ports("") == [])

# ---- samplers: a failed probe must NOT veto a frame (agent/lib/screenshot.js)
state_dir = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(TMP, "state")
p = paths(resolve_state_dir(state_dir))
os.makedirs(p["pending"], exist_ok=True)
warnings = []
capturer = Capturer(p["pending"], on_warn=warnings.append)
png_target = os.path.join(TMP, "tiny.png")
with open(png_target, "wb") as fh:
    fh.write(b"\x89PNG\r\n\x1a\n" + b"0" * 40)

real_run_json = probes.run_json


def stub(value):
    def run_json(script, **kwargs):
        # The probe's contract is "write the png, then report"; the stub has to do both or the
        # capture path legitimately fails on a missing file instead of testing the probe verdicts.
        target = (kwargs.get("args") or [None])[0]
        if value.get("captured") and target:
            shutil.copyfile(png_target, target)
        return value, None
    return run_json


probes.run_json = stub({"locked": False, "idle_seconds": 0, "idle_probe": "error",
                        "desktop_probe": "unavailable", "captured": True, "width": 10,
                        "height": 8, "gray_cells": [10] * 72, "error": None})
out = capturer.capture(idle_skip_seconds=5, skip_when_locked=True)
ok("a failing idle/desktop probe still yields a frame", out["captured"] is True, str(out["state"]))
ok("the failed probes are warned about, not swallowed",
   any("idle probe error" in w for w in warnings) and any("desktop probe unavailable" in w for w in warnings),
   "; ".join(warnings))

warnings.clear()
probes.run_json = stub({"locked": True, "idle_seconds": 99, "idle_probe": "ok",
                        "desktop_probe": "ok", "captured": False, "error": None})
out = capturer.capture(idle_skip_seconds=5, skip_when_locked=True)
ok("a probe that answers 'locked' does veto the frame",
   out["captured"] is False and out["state"] == "locked", str(out))

warnings.clear()
probes.run_json = stub({"locked": False, "idle_seconds": 99, "idle_probe": "ok",
                        "desktop_probe": "ok", "captured": True, "gray_cells": [1] * 72})
out = capturer.capture(idle_skip_seconds=5, skip_when_locked=True)
ok("a known idle verdict above the skip still skips",
   out["captured"] is False and out["state"] == "idle", str(out))

probes.run_json = stub({"locked": False, "idle_seconds": 99, "idle_probe": "unavailable",
                        "desktop_probe": "ok", "captured": True, "gray_cells": [1] * 72})
out = capturer.capture(idle_skip_seconds=5, skip_when_locked=True)
ok("an unknown idle verdict cannot skip: idle_probe gates the veto",
   out["captured"] is True, str(out))
probes.run_json = real_run_json

# ---- producers: a capture failure reason is logged once per distinct reason
logs = []


class SpoolStub:
    def __init__(self):
        self.events = []

    def append(self, event):
        self.events.append(event)

    def write_blob(self, event_id, png):
        return os.path.join(TMP, f"{event_id}.png")

    def pending_blob_files(self):
        return []


class CapStub:
    def __init__(self, results):
        self.results = list(results)

    def __call__(self, **kwargs):
        return self.results.pop(0) if len(self.results) > 1 else self.results[0]


policy = PolicyState(os.path.join(TMP, "policy.json"))
policy.replace({"values": {
    "screenshot_interval_minutes": 1, "idle_skip_seconds": 300, "skip_when_locked": True,
    "dedupe_unchanged_frames": True, "screenshot_max_bytes": 4000000,
    "clipboard_metrics_enabled": True, "clipboard_sample_seconds": 60,
    "extension_inventory_enabled": True, "ext_inventory_max_age_hours": 24,
    "heartbeat_interval_seconds": 60, "batch_max_items": 200, "batch_max_bytes": 200000,
    "batch_max_age_seconds": 300, "spool_max_bytes": 1000000, "screenshot_retention_days": 30,
}}, "etag")
spool = SpoolStub()
producers = Producers(spool, policy, lambda: "dev", CapStub([
    {"captured": False, "state": "active", "reason": "no desktop handle"},
    {"captured": False, "state": "active", "reason": "no desktop handle"},
    {"captured": False, "state": "active", "reason": "something else"},
]), lambda: None, logs.append)
producers.screenshot_tick()
producers.screenshot_tick()
producers.screenshot_tick()
reason_logs = [line for line in logs if line.startswith("capture unavailable:")]
ok("a capture failure is logged once per distinct reason",
   reason_logs == ["capture unavailable: no desktop handle", "capture unavailable: something else"],
   " | ".join(reason_logs))
ok("the screen_state event still records the state as active when capture failed",
   all(e["data"]["state"] == "active" for e in spool.events) and len(spool.events) == 3,
   str([e["data"]["state"] for e in spool.events]))

# ---- disclosure: the listener set is static disclosure, notices are part of it
opts = {"host": "10.0.0.5", "ports": [8443, 9447], "port": 8443}
ident = {"source": "smb", "has_smb_uuid": True}
write_disclosure_config(p, policy, opts, state_dir, ident)
config = json.load(open(p["config"], encoding="utf8"))
ok("config.json states the whole port set, not one port",
   config["collector"].get("ports") == [8443, 9447] and "port" not in config["collector"],
   str(config["collector"]))
notices = config.get("device_user_notices")
ok("config.json discloses the on-screen notices",
   notices and notices["shown_on_screen"] is True and len(notices["when"]) == 3,
   str(notices))

print()
failed = [name for good, name, _ in results if not good]
print(f"{len(results) - len(failed)}/{len(results)} assertions passed")
sys.exit(1 if failed else 0)
