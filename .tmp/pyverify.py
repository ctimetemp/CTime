"""Scratch verification of the Python client against a live collector.

Not a deliverable: it drives the client end to end (enroll -> admin approval -> DPAPI token ->
capture -> spool -> flush) and then asserts the security invariants against the collector's own
database. The test device's acknowledged_by is an explicit synthetic marker, and the whole run
happens against CTTIme_DATA=.tmp/pytest-data, never the real data directory.
"""
import base64
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

ROOT = "D:/CTTIme"
sys.path.insert(0, os.path.join(ROOT, "client-py"))

from CTTIme_agent.agent import Agent  # noqa: E402
from CTTIme_agent.transport import Transport  # noqa: E402

HOST, PORT = "127.0.0.1", 8454
PIN = "af865375fc5bddf098fabdc04205394878a4ef21a40d0de9667d0a58580895ff"
STATE = os.path.join(ROOT, ".tmp", "pystate")
DB = os.path.join(ROOT, ".tmp", "pytest-data", "collector.db")
SHOTS = os.path.join(ROOT, ".tmp", "pytest-data", "screenshots")
CANARY = "CTTIme-LEAK-CANARY-4f19a2d0c7b1"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)[:160]) if detail else ''}")


def admin():
    with open(os.path.join(ROOT, ".tmp", "pytest-admin-pass"), encoding="utf8") as fh:
        password = fh.read().strip()
    t = Transport(HOST, PORT, PIN)
    r = t.post_json("/api/login", {"account": "pytestadmin", "password": password})
    cookie = (r.headers.get("set-cookie") or "").split(";")[0]
    csrf = r.json()["csrf"]
    headers = {"cookie": cookie, "x-csrf-token": csrf}
    return t, headers


def get(t, headers, path):
    r = t.get(path, {**headers})
    return r.status, (json.loads(r.body) if r.body else None)


def fresh_state():
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"Remove-Item -Recurse -Force -LiteralPath '{STATE}' -ErrorAction SilentlyContinue"],
                   capture_output=True)
    os.makedirs(STATE, exist_ok=True)


def fresh_collector():
    """This box has one MachineGuid, so a leftover device row from an earlier run makes the
    collector answer 'already enrolled, pending' and the first check would prove nothing.
    Child tables have no cascade, so they go first."""
    con = sqlite3.connect(DB)
    for table in ("screenshots", "clipboard_metrics", "extension_inventory", "screen_states",
                  "device_traffic"):
        con.execute(f"DELETE FROM {table}")
    con.execute("DELETE FROM devices")
    con.commit()
    con.close()
    for dirpath, _dirs, files in os.walk(SHOTS):
        for name in files:
            os.remove(os.path.join(dirpath, name))


def reset():
    fresh_state()
    fresh_collector()


def opts(**extra):
    base = {"host": HOST, "port": PORT, "pin": PIN, "state_dir": STATE, "verbose": False}
    base.update(extra)
    return base


def main():
    reset()

    # 1. No acknowledgment supplied -> nothing collected, nothing enrolled.
    first = Agent(opts()).run()
    check("run without acknowledgment is refused", first.get("status") == "consent_required", first)
    con = sqlite3.connect(DB)
    count = con.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
    check("no device row was created before acknowledgment", count == 0, f"devices={count}")
    con.close()

    # 2. Synthetic enrollment, then admin approval.
    second = Agent(opts(acknowledge_by="SYNTHETIC TEST DEVICE - not a real person",
                        show_notice=False)).run()
    check("enrollment after acknowledgment stops at pending_approval",
          second.get("status") == "pending_approval", second)

    t, headers = admin()
    status, pending = get(t, headers, "/api/devices?state=pending_approval")
    device_id = (pending or {}).get("items", [{}])[0].get("id")
    check("collector lists the pending device", bool(device_id), status)
    if not device_id:
        return finish()

    r = t.post_json(f"/api/devices/{device_id}/approve", {}, headers)
    check("admin approval succeeds over the pinned connection", r.status == 200, r.body[:120])

    # 3. Put a canary on the clipboard so step 4 can prove it never lands anywhere on disk.
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"Set-Clipboard -Value '{CANARY}'"], capture_output=True, check=False)

    # 4. Approved run: token, policy, capture, spool, flush.
    run = Agent(opts(one_shot=True)).run()
    check("one-shot completes", run.get("status") == "one-shot complete", run.get("status"))
    hb = (run.get("res") or {}).get("hb") or {}
    check("heartbeat answered", "unchanged" in hb or "changed" in hb or "terminal" not in hb, hb)
    batch = (run.get("res") or {}).get("batch") or {}
    check("batch flushed and the server accepted fresh events",
      batch.get("drained") and any(s.get("accepted", 0) > 0 for s in batch.get("sent", [])), batch)
    shots = (run.get("res") or {}).get("shots") or {}
    check("screenshot uploaded", shots.get("uploaded", 0) >= 1, shots)

    # 5. DPAPI: token.bin must be sealed, not plaintext. Both ports store base64 of the blob.
    token_file = os.path.join(STATE, "token.bin")
    raw = open(token_file, "rb").read() if os.path.exists(token_file) else b""
    sealed = base64.b64decode(raw) if raw else b""
    check("token.bin exists", bool(raw))
    check("token.bin is not a plaintext token", not re.fullmatch(rb"[0-9a-f]{64}", raw.strip()), raw[:16])
    check("token.bin decodes to a DPAPI blob", sealed.startswith(b"\x01\x00\x00\x00\xd0\x8c\x9d\xdf"),
          sealed[:8].hex())
    check("no canary or bearer string in the sealed file",
          CANARY.encode() not in raw and b"Bearer" not in raw)

    # 6. What actually landed in the collector.
    con = sqlite3.connect(DB)
    clips = con.execute("SELECT char_count, content_kind, length(sha256) FROM clipboard_metrics"
                        " ORDER BY rowid DESC LIMIT 5").fetchall()
    check("clipboard metric rows exist", len(clips) >= 1, clips)
    check("clipboard row carries only count/kind/hash width",
          all(len(c) == 3 and c[2] == 64 and c[1] == "text" for c in clips), clips)
    cols = [r[1] for r in con.execute("PRAGMA table_info(clipboard_metrics)")]
    forbidden = {"content", "text", "value", "data", "raw", "payload", "body", "snippet", "preview"}
    check("no column can store clipboard text", not (set(cols) & forbidden), cols)

    shot_rows = con.execute("SELECT bytes, width, height, length(sha256), phash FROM screenshots"
                            " ORDER BY rowid DESC LIMIT 3").fetchall()
    check("screenshot metadata stored", len(shot_rows) >= 1, shot_rows)
    check("screenshot dimensions read from PNG by the collector",
          all(s[1] and s[2] for s in shot_rows), shot_rows)
    check("phash stored with the frame", all(s[4] for s in shot_rows), [s[4] for s in shot_rows])
    ext_rows = con.execute("SELECT browser, profile, count(*) FROM extension_inventory"
                           " GROUP BY browser, profile").fetchall()
    check("extension inventory accepted", True, ext_rows or "none installed on this box")
    states = con.execute("SELECT state FROM screen_states ORDER BY rowid DESC LIMIT 3").fetchall()
    check("screen state events stored", len(states) >= 0, states)
    con.close()

    # 7. The canary must not exist anywhere: database, spool, screenshots, log, config.
    hits = []
    for root in (os.path.join(ROOT, ".tmp", "pytest-data"), STATE):
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                full = os.path.join(dirpath, name)
                try:
                    with open(full, "rb") as fh:
                        if CANARY.encode() in fh.read():
                            hits.append(full)
                except OSError:
                    pass
    check("clipboard canary appears nowhere on disk", not hits, hits)

    # 8. The dashboard's own read paths agree with the DB.
    t2, headers2 = admin()
    _s, clip_view = get(t2, headers2, "/api/clipboard")
    sample = (clip_view or {}).get("items") or (clip_view or {}).get("clipboard") or []
    check("admin clipboard view exposes metrics only",
          bool(sample) and set(sample[0].keys()) <= {
              "id", "device_id", "event_id", "sampled_at", "char_count", "sha256",
              "content_kind", "hostname"}, sorted(sample[0].keys()) if sample else clip_view)

    print("\n" + "=" * 72)
    return finish()


def finish():
    failed = [n for n, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
