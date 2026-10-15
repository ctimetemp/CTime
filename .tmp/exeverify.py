"""Drive the packaged CTTImeAgent.exe through the same flow the source client is verified with.

The point is the packaging, not the logic: the exe has to find the bundled PowerShell probes,
write the same disclosure files, and land the same rows in the collector.
"""
import json
import os
import sqlite3
import subprocess
import sys

sys.path.insert(0, "D:/CTTIme/client-py")
sys.path.insert(0, "D:/CTTIme/.tmp")

import pyverify

EXE = "D:/CTTIme/dist/CTTImeAgent.exe"
ACK = "SYNTHETIC TEST DEVICE - not a real person"
pyverify.results.clear()


def run(*args, expect_zero=True, pin=None):
    cmd = [EXE, *args, "--host", pyverify.HOST, "--port", str(pyverify.PORT),
           "--pin", pin or pyverify.PIN, "--state-dir", pyverify.STATE]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)
    label = args[0]
    ok = proc.returncode == 0
    if expect_zero and not ok:
        print(f"FAIL  {label} exited {proc.returncode}\n{proc.stdout[-800:]}\n{proc.stderr[-800:]}")
    return proc


pyverify.reset()
help_out = run("--help")
pyverify.check("exe prints usage", "what-collects" in help_out.stdout, help_out.stdout[:60])

refused = run("one-shot", "--no-notice", expect_zero=False)
parsed = None
try:
    parsed = json.loads(refused.stdout)
except ValueError:
    pass
pyverify.check("exe refuses to collect without acknowledgment",
               (parsed or {}).get("status") == "consent_required", parsed or refused.stdout[:120])

enrolled = run("one-shot", "--acknowledge-by", ACK, "--no-notice")
status = json.loads(enrolled.stdout).get("status")
pyverify.check("exe enrollment stops at pending_approval", status == "pending_approval", status)

t, headers = pyverify.admin()
_s, pending = pyverify.get(t, headers, "/api/devices?state=pending_approval")
device_id = pending["items"][0]["id"]
t.post_json(f"/api/devices/{device_id}/approve", {}, headers)

subprocess.run(["powershell", "-NoProfile", "-Command",
                f"Set-Clipboard -Value '{pyverify.CANARY}'"], capture_output=True, check=False)

shot = run("one-shot")
out = json.loads(shot.stdout)
pyverify.check("exe one-shot completes", out.get("status") == "one-shot complete", out.get("status"))
batch = (out.get("res") or {}).get("batch") or {}
pyverify.check("exe batch accepted (probes found inside the package)",
               batch.get("drained") and any(s.get("accepted", 0) > 0 for s in batch.get("sent", [])),
               batch)
pyverify.check("exe screenshot uploaded",
               (out.get("res") or {}).get("shots", {}).get("uploaded", 0) >= 1,
               (out.get("res") or {}).get("shots"))

con = sqlite3.connect(pyverify.DB)
rows = con.execute("SELECT char_count, content_kind, length(sha256) FROM clipboard_metrics"
                   " ORDER BY rowid DESC LIMIT 1").fetchall()
pyverify.check("exe stored a metrics-only clipboard row",
               rows and rows[0][1] == "text" and rows[0][2] == 64, rows)
shots = con.execute("SELECT bytes, width, height, phash FROM screenshots ORDER BY rowid DESC LIMIT 1")
row = shots.fetchone()
pyverify.check("exe frame stored with collector-read dimensions",
               bool(row) and all(row), row)
con.close()

for name in ("config.json", "agent.log", "identity.json", "token.bin"):
    path = os.path.join(pyverify.STATE, name)
    pyverify.check(f"exe wrote {name}", os.path.exists(path))

what = run("what-collects")
pyverify.check("what-collects names every sensor",
               all(word in what.stdout for word in ("screenshot", "clipboard", "extension")),
               what.stdout[:100])

bad = run("check", expect_zero=False, pin="00" * 32)
pyverify.check("exe refuses a wrong pin before sending",
               "tls_pin_mismatch" in (bad.stdout + bad.stderr)
               and pyverify.CANARY not in (bad.stdout + bad.stderr),
               (bad.stdout + bad.stderr)[:120])

subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value ''"],
               capture_output=True, check=False)
sys.exit(pyverify.finish())
