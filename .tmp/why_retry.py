import sys, http.client, traceback
sys.path.insert(0, "D:/CTTIme/client-py")
sys.path.insert(0, "D:/CTTIme/.tmp")
_n = 0
_orig = http.client.HTTPConnection.getresponse
def gr(self):
    global _n
    _n += 1
    try:
        r = _orig(self)
        print(f"  getresponse[{_n}] ok -> {r.status}")
        return r
    except Exception as e:
        print(f"  getresponse[{_n}] RAISED {type(e).__name__}: {e}")
        print("   socket:", getattr(self, "sock", None))
        raise
http.client.HTTPConnection.getresponse = gr
import pyverify
from CTTIme_agent.agent import Agent
Agent(pyverify.opts(one_shot=True)).run()
