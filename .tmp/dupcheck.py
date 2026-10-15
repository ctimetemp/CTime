"""Clean-state reproduction of the 'fresh events counted as duplicates' report.

Wipes the test device rows and state dir, enrolls with the synthetic marker, approves, then runs
one one-shot with every batch line and its server answer printed.
"""
import sys, os, json, sqlite3
sys.path.insert(0, "D:/CTTIme/client-py")
sys.path.insert(0, "D:/CTTIme/.tmp")

import pyverify
from CTTIme_agent import transport as T
from CTTIme_agent.agent import Agent

_orig = T.Transport.post_gzip_ndjson
def traced(self, path, events, headers=None):
    print(f"BATCH {len(events)} lines:")
    for e in events:
        print("  ", e["type"], e["event_id"])
    r = _orig(self, path, events, headers)
    print("  ->", r.body)
    return r
T.Transport.post_gzip_ndjson = traced

pyverify.reset()
print("enroll:", Agent(pyverify.opts(
    acknowledge_by="SYNTHETIC TEST DEVICE - not a real person", show_notice=False)).run().get("status"))

t, headers = pyverify.admin()
status, pending = pyverify.get(t, headers, "/api/devices?state=pending_approval")
device_id = pending["items"][0]["id"]
t.post_json(f"/api/devices/{device_id}/approve", {}, headers)
print("approved", device_id)

con = sqlite3.connect(pyverify.DB)
print("rows before one-shot: clip=",
      con.execute("SELECT count(*) FROM clipboard_metrics").fetchone()[0],
      "ext=", con.execute("SELECT count(DISTINCT event_id) FROM extension_inventory").fetchone()[0])
con.close()

print("\n--- one-shot ---")
out = Agent(pyverify.opts(one_shot=True)).run()
print("RESULT batch:", json.dumps(out["res"]["batch"]))

con = sqlite3.connect(pyverify.DB)
print("DB clip:", con.execute("SELECT event_id, char_count FROM clipboard_metrics").fetchall())
print("DB ext :", con.execute("SELECT DISTINCT event_id FROM extension_inventory").fetchall())
con.close()
