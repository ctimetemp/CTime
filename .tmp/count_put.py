import sys, os, http.client, json
sys.path.insert(0, "D:/CTTIme/client-py")
sys.path.insert(0, "D:/CTTIme/.tmp")
_orig_put = http.client.HTTPConnection.putrequest
_orig_end = http.client.HTTPConnection.endheaders
_orig_send = http.client.HTTPConnection.send
def put(self, method, url, *a, **k):
    print(f"  [wire] {method} {url}")
    return _orig_put(self, method, url, *a, **k)
def end(self, *a, **k):
    r = _orig_end(self, *a, **k)
    print("  [wire]   headers flushed")
    return r
def send(self, d, *a, **k):
    n = len(d) if hasattr(d, "__len__") else -1
    print(f"  [wire]   send({n} bytes)")
    return _orig_send(self, d, *a, **k)
http.client.HTTPConnection.putrequest = put
http.client.HTTPConnection.endheaders = end
http.client.HTTPConnection.send = send

import pyverify
from CTTIme_agent import transport as T
from CTTIme_agent.agent import Agent
_orig = T.Transport._request
def traced(self, method, path, headers, body, expect, stream_file=None):
    print(f"REQ {method} {path}")
    try:
        r = _orig(self, method, path, headers, body, expect, stream_file)
        print("   answer:", r.body[:60]); return r
    except Exception as e:
        print("   raised:", type(e).__name__, e); raise
T.Transport._request = traced
out = Agent(pyverify.opts(one_shot=True)).run()
print("RESULT:", json.dumps(out["res"]["batch"]))
