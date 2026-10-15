"""Isolate the node agent's post-approval gate poll against one scratch collector.

The harness deletes state dirs on exit, so the full `cert <hex> does not match the pin`
detail was never readable. This keeps the state dir and prints the whole log.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lcverify as lc

PORT = 8466
STATE = os.path.join(lc.TMP, "nsgate")
PAIR = os.path.join(lc.TMP, "nspair")


def main():
    col = lc.Collector(PORT).start()
    pin = col.pin
    print(f"pin from fingerprint.txt: {pin}\n")

    # 1. the acknowledgment step, in its own deliberate process
    out = lc.enroll_one_shot(PORT, pin, PAIR)
    print(f"enroll rc tail: {out[-200:]}\n")
    session, csrf = lc.session_pair(PORT)
    ids = lc.pending_ids(PORT, session)
    print(f"pending: {ids}\n")
    if not ids:
        print("no pending device; nothing to approve")
        return 1

    # 2. the already-running node agent, state dir kept this time
    shutil.rmtree(STATE, ignore_errors=True)
    os.makedirs(STATE, exist_ok=True)
    node = subprocess.Popen(
        ["node", "cli.js", "run", "--host", "127.0.0.1", "--port", str(PORT),
         "--pin", pin, "--state-dir", STATE],
        cwd=os.path.join(lc.ROOT, "agent"), stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT)
    try:
        time.sleep(8)
        status, body, _ = lc.approve(PORT, csrf, session, ids[0])
        print(f"approve -> {status} {json.dumps(body)[:120]}\n")
        time.sleep(70)
    finally:
        lc.kill_tree(node.pid)

    log = os.path.join(STATE, "agent.log")
    print(f"--- agent.log ({log}) ---")
    if os.path.exists(log):
        print(open(log, encoding="utf8", errors="replace").read()[-3000:])
    else:
        print("MISSING; state dir contents:")
        for root, _d, files in os.walk(STATE):
            for f in files:
                print(os.path.join(root, f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
