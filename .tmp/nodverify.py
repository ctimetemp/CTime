"""End-to-end run of the Node client against the isolated test collector.

Same consent gate, same assertions as the Python harness, but the subject is agent/cli.js: the
point is to see whether a screenshot actually uploads.
"""
import json
import os
import sqlite3
import subprocess
import sys

sys.path.insert(0, "D:/CTTIme/client-py")
sys.path.insert(0, "D:/CTTIme/.tmp")

import pyverify

STATE = "D:/CTTIme/.tmp/nodestate"
ACK = "SYNTHETIC TEST DEVICE - not a real person"
NODE = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()


def node(*args, pin=None):
    cmd = ["node", "D:/CTTIme/agent/cli.js", *args,
           "--host", pyverify.HOST, "--port", str(pyverify.PORT),
           "--pin", pin or pyverify.PIN, "--state-dir", STATE]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)
    return proc


pyverify.results.clear()
pyverify.fresh_state()
subprocess.run(["powershell", "-NoProfile", "-Command",
                f"Remove-Item -Recurse -Force -LiteralPath '{STATE}' -ErrorAction SilentlyContinue"],
               capture_output=True)
pyverify.fresh_collector()
print("node", NODE, "| python client at", pyverify.STATE, "untouched")

refused = node("one-shot", "--no-notice")
parsed = None
try:
    parsed = json.loads(refused.stdout)
except ValueError:
    pass
pyverify.check("node run refuses without acknowledgment",
               (parsed or {}).get("status") == "consent_required", parsed or refused.stdout[:160])

enrolled = node("one-shot", "--acknowledge-by", ACK, "--no-notice")
status = (json.loads(enrolled.stdout) or {}).get("status") if enrolled.stdout.strip() else None
pyverify.check("node enrollment stops at pending_approval", status == "pending_approval",
               status or enrolled.stdout[:160] + enrolled.stderr[:160])

t, headers = pyverify.admin()
_s, pending = pyverify.get(t, headers, "/api/devices?state=pending_approval")
device_id = pending["items"][0]["id"]
t.post_json(f"/api/devices/{device_id}/approve", {}, headers)

subprocess.run(["powershell", "-NoProfile", "-Command",
                f"Set-Clipboard -Value '{pyverify.CANARY}'"], capture_output=True, check=False)

run = node("one-shot")
out = json.loads(run.stdout) if run.stdout.strip() else {}
pyverify.check("node one-shot completes", out.get("status") in ("one-shot complete", "one-shot"),
               out.get("status") or run.stdout[:200] + run.stderr[:200])
res = out.get("res") or out
batch = res.get("batch") or {}
pyverify.check("node batch accepted fresh events",
               any((s.get("accepted", 0) > 0) for s in (batch.get("sent") or [])), batch)
shots = res.get("shots") or res.get("screenshots") or {}
pyverify.check("node screenshot uploaded", shots.get("uploaded", 0) >= 1, shots)
pyverify.check("node reported no terminal error", not (res.get("lastError") or out.get("error")),
               res.get("lastError") or out.get("error"))

con = sqlite3.connect(pyverify.DB)
row = con.execute("SELECT bytes, width, height, length(sha256) FROM screenshots"
                  " ORDER BY rowid DESC LIMIT 1").fetchone()
pyverify.check("node frame stored with dimensions", bool(row) and all(row), row)
clip = con.execute("SELECT char_count, content_kind FROM clipboard_metrics"
                   " ORDER BY rowid DESC LIMIT 1").fetchone()
pyverify.check("node clipboard row is metrics only", clip == (len(pyverify.CANARY), "text"), clip)
con.close()

hits = []
for root in ("D:/CTTIme/.tmp/pytest-data", STATE):
    for dirpath, _d, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            try:
                with open(full, "rb") as fh:
                    if pyverify.CANARY.encode() in fh.read():
                        hits.append(full)
            except OSError:
                pass
pyverify.check("canary absent from collector data and node state", not hits, hits)

subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value ''"],
               capture_output=True, check=False)
sys.exit(pyverify.finish())
