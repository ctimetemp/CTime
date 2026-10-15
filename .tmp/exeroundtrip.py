"""Round trip through the shipped executables, not the source tree.

The user's complaint is that the packaged agent does not run, so this drives exactly what gets
handed out: dist\CTTImeAgent.exe (the builtin) and dist\CTTImeSetup.exe (the Node payload).
It boots a throwaway collector, tightens the policy to its fastest legal intervals so a real
capture-and-flush cycle completes inside the window, and then asks the collector's own
verification endpoint whether the device is working.

The acknowledgment name is the same obviously-synthetic marker the lifecycle harness uses, and it
is only ever sent to this scratch collector's database.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lcverify as lc

DIST = os.path.join(lc.ROOT, "dist")
PY_EXE = os.path.join(DIST, "CTTImeAgent.exe")
SETUP_EXE = os.path.join(DIST, "CTTImeSetup.exe")
PORT = 8462
ACK = "SYNTHETIC TEST DEVICE - not a real person"
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))
    return ok


def run_exe(exe, args, pin, state, cwd=None, timeout=180):
    cmd = [exe, *args, "--host", "127.0.0.1", "--port", str(PORT), "--pin", pin,
           "--state-dir", state]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf8", errors="replace",
                       timeout=timeout, cwd=cwd)
    return p


def tighten_policy(col):
    session, csrf = lc.session_pair(PORT)
    changed = {"heartbeat_interval_seconds": 30, "clipboard_sample_seconds": 15,
               "screenshot_interval_minutes": 1, "batch_max_age_seconds": 10,
               "idle_skip_seconds": 0}
    status, body, _ = lc.call(PORT, "PUT", "/api/policy", {"changed": changed},
                              {"x-csrf-token": csrf, "cookie": f"CTTIme_session={session}"})
    return status, body, session, csrf


def main():
    for exe in (PY_EXE, SETUP_EXE):
        if not os.path.exists(exe):
            print(f"! missing {exe}")
            return 1
    print("\nPackaged-agent round trip\n")

    col = lc.Collector(PORT).start()
    pin = col.pin
    print(f"  collector on {PORT}, pin {pin[:12]}…")

    status, body, session, csrf = tighten_policy(col)
    check("the collector accepts a live policy change to its fastest intervals",
          status == 200, f"{status} {json.dumps(body)[:120]}")

    # --- the builtin exe: check, then the deliberate acknowledgment, then the resident run ----
    state = os.path.join(lc.TMP, "exestate")
    chk = run_exe(PY_EXE, ["check"], pin, state)
    check("CTTImeAgent.exe check runs and pins the certificate",
          chk.returncode == 0 and "pin" in (chk.stdout + chk.stderr).lower(),
          (chk.stdout + chk.stderr).strip().splitlines()[-1][:150] if chk.stdout.strip() else chk.stderr[:150])

    pair = os.path.join(lc.TMP, "exeair")
    enr = run_exe(PY_EXE, ["one-shot", "--acknowledge-by", ACK], pin, pair)
    ids = lc.pending_ids(PORT, session)
    check("CTTImeAgent.exe one-shot enrolled a pending device", bool(ids), f"pending: {len(ids)}")
    if not ids:
        print(f"      enroll output: {(enr.stdout + enr.stderr)[-300:]}")
        return 1
    device_id = ids[0]

    status, body, _ = lc.approve(PORT, csrf, session, device_id)
    check("admin approval accepted", status == 200, json.dumps(body)[:100])

    proc = subprocess.Popen([PY_EXE, "run", "--host", "127.0.0.1", "--port", str(PORT),
                            "--pin", pin, "--state-dir", state],
                            cwd=lc.TMP, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    verdict = None
    steps = []
    counts = {}
    v_body = {}
    try:
        deadline = time.time() + 240
        while time.time() < deadline:
            v_status, v_body, _ = lc.call(PORT, "GET", f"/api/devices/{device_id}/verify", None,
                                          {"cookie": f"CTTIme_session={session}"})
            if v_status == 200:
                verdict = v_body.get("verdict")
                steps = v_body.get("steps") or []
                counts = v_body.get("counts") or {}
                if verdict == "working":
                    break
            time.sleep(5)
    finally:
        lc.kill_tree(proc.pid)

    detail = json.dumps({"verdict": verdict, "counts": counts,
                         "headline": (v_body or {}).get("headline")})[:300]
    check("the shipped exe reached a working round trip on the collector",
          verdict == "working", detail)
    check("the collector recorded real rows from it, not just a heartbeat",
          sum((counts or {}).values()) > 0, f"counts: {json.dumps(counts)}")
    check("every verification step the dashboard shows is satisfied",
          all(s.get("done") for s in steps) and len(steps) >= 4,
          json.dumps([s.get("label") for s in steps])[:200])

    # --- the Node payload inside CTTImeSetup.exe ----------------------------------------------
    pack = os.path.join(lc.TMP, "exepack")
    shutil.rmtree(pack, ignore_errors=True)
    unpack = subprocess.run([SETUP_EXE, "unpack", "--state-dir", pack], capture_output=True,
                            text=True, encoding="utf8", errors="replace", timeout=300)
    transported = os.path.join(pack, "setup", "agent", "lib", "transport.js")
    runtime = os.path.join(pack, "runtime", "node.exe")
    check("CTTImeSetup.exe unpacks its payload", unpack.returncode == 0 and os.path.exists(runtime),
          (unpack.stdout + unpack.stderr).strip().splitlines()[-1][:150])
    body_text = ""
    if os.path.exists(transported):
        body_text = open(transported, encoding="utf8").read()
    check("the payload carries the certificate-pinning fix",
          "maxCachedSessions: 0" in body_text,
          "resumed TLS sessions carry no certificate; the pin must be compared on every handshake")

    node_check = subprocess.run(
        [runtime, "cli.js", "check", "--host", "127.0.0.1", "--port", str(PORT), "--pin", pin,
         "--state-dir", os.path.join(lc.TMP, "exestate")],
        cwd=os.path.join(pack, "setup", "agent"), capture_output=True, text=True,
        encoding="utf8", errors="replace", timeout=180)
    check("the bundled runtime runs the packaged Node agent",
          node_check.returncode == 0,
          (node_check.stdout + node_check.stderr).strip().splitlines()[-1][:150])

    for name in ("exestate", "exeair", "exepack"):
        shutil.rmtree(os.path.join(lc.TMP, name), ignore_errors=True)
    col.stop()
    print(f"\n{sum(results)}/{len(results)} packaged checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
