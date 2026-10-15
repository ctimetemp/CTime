import sys, os, gzip, json
sys.path.insert(0, "D:/CTTIme/client-py")
from CTTIme_agent import transport as T
from CTTIme_agent.agent import Agent
import sqlite3

_orig = T.Transport.post_gzip_ndjson
def traced(self, path, events, headers=None):
    print("BATCH LINES:")
    for e in events:
        print("  ", e.get("type"), e.get("event_id"), json.dumps(e.get("data"))[:60])
    r = _orig(self, path, events, headers)
    print("  ->", r.body)
    return r
T.Transport.post_gzip_ndjson = traced

o = {"host": "127.0.0.1", "port": 8454,
     "pin": "af865375fc5bddf098fabdc04205394878a4ef21a40d0de9667d0a58580895ff",
     "state_dir": "D:/CTTIme/.tmp/pystate", "verbose": False, "one_shot": True}
Agent(o).run()

con = sqlite3.connect("D:/CTTIme/.tmp/pytest-data/collector.db")
print("DB clip:", con.execute("SELECT event_id FROM clipboard_metrics").fetchall())
print("DB ext :", con.execute("SELECT DISTINCT event_id FROM extension_inventory").fetchall())
print("DB shot:", con.execute("SELECT event_id FROM screenshots").fetchall())
print("DB st  :", con.execute("SELECT event_id, state FROM screen_states").fetchall())
