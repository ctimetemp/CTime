"""Send one hand-made batch event straight to the collector.

Used to separate a client that re-sends events from a collector that mislabels a fresh insert.
"""
import sys, os, json, uuid, sqlite3
sys.path.insert(0, "D:/CTTIme/client-py")
from CTTIme_agent.transport import Transport
from CTTIme_agent.clock import now_iso
from CTTIme_agent.token import open_token
from CTTIme_agent.producers import envelope

STATE = "D:/CTTIme/.tmp/pystate"
DB = "D:/CTTIme/.tmp/pytest-data/collector.db"
ident = json.load(open(os.path.join(STATE, "identity.json"), encoding="utf8"))
token = open_token(os.path.join(STATE, "token.bin"))
print("token chars:", len(token or ""))

t = Transport("127.0.0.1", 8454,
              "af865375fc5bddf098fabdc04205394878a4ef21a40d0de9667d0a58580895ff")
eid = str(uuid.uuid4())
ev = envelope("clipboard_metric", ident["device_id"],
              {"sampled_at": now_iso(), "char_count": 7, "sha256": "ab" * 32,
               "content_kind": "text"})
ev["event_id"] = eid
print("sending", eid)
r = t.post_gzip_ndjson("/api/v1/batch", [ev], {"authorization": f"Bearer {token}",
                                               "x-device-id": ident["device_id"]})
print("server said:", r.body)
con = sqlite3.connect(DB)
print("row present:", con.execute(
    "SELECT event_id, char_count FROM clipboard_metrics WHERE event_id=?", (eid,)).fetchall())
con.close()
