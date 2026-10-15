"""Wrap Transport._request to print every HTTP attempt, so a duplicate-looking batch can be
attributed to a client retry rather than to a server-side conflict."""
import sys, os, time
sys.path.insert(0, os.path.join("D:/CTTIme", "client-py"))
from CTTIme_agent import transport as T
from CTTIme_agent.agent import Agent

_orig = T.Transport._request
def traced(self, method, path, headers=None, body=None, expect=None, stream_file=None):
    t0 = time.time()
    try:
        r = _orig(self, method, path, headers, body, expect, stream_file)
        print(f"REQ {method} {path} -> {r.status} {str(r.body)[:70]} ({time.time()-t0:.2f}s)")
        return r
    except Exception as err:
        print(f"REQ {method} {path} !! {type(err).__name__}: {err} ({time.time()-t0:.2f}s)")
        raise
T.Transport._request = traced

o = {"host": "127.0.0.1", "port": 8454,
     "pin": "af865375fc5bddf098fabdc04205394878a4ef21a40d0de9667d0a58580895ff",
     "state_dir": "D:/CTTIme/.tmp/pystate", "verbose": False, "one_shot": True}
print(json_out := Agent(o).run())
