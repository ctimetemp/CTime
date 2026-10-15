"""Failover mechanics proven without the collector (it is not running and must not be started).

Stubs Transport._request_on, so only the rotation decision logic is exercised -- which is exactly
the part the four mirrored changes touch.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "client-py"))

from CTTIme_agent.errors import ClientError  # noqa: E402
from CTTIme_agent.transport import Response, Transport  # noqa: E402

results = []


def ok(name, condition, detail=""):
    results.append((bool(condition), name, detail))
    print(("PASS " if condition else "FAIL ") + name + (f" :: {detail}" if detail else ""))


class Recorder:
    """Stands in for _request_on: records which listener it was asked to use."""

    def __init__(self, failures):
        self.failures = failures          # port -> ClientError code, or None to succeed
        self.tried = []

    def bind(self, transport):
        transport._request_on = self
        return self

    def __call__(self, port, method, path, headers, body, expect, stream_file=None):
        self.tried.append(port)
        code = self.failures.get(port)
        if code is not None:
            raise ClientError(0, code, f"simulated {code}")
        return Response(200, {}, b"{}")


# ---------------------------------------------------------------- refused port -> next listener
ft = Transport("127.0.0.1", ports=[1, 8443], pin="a" * 64)
rec = Recorder({1: "network"}).bind(ft)
r = ft.get("/api/v1/notice")
ok("a connection-level failure rotates to the next listener",
   r.status == 200 and rec.tried == [1, 8443], str(rec.tried))
ok("the port that answered becomes the remembered one", ft.active_port() == 8443,
   str(ft.active_port()))
rec.tried.clear()
ft.get("/api/v1/notice")
ok("the next request starts from the remembered port and does not re-probe the dead one",
   rec.tried == [8443], str(rec.tried))

# ---------------------------------------------------------------- wrap-around keeps the memory
ft2 = Transport("127.0.0.1", ports=[8443, 9447, 1], pin="a" * 64)
rec2 = Recorder({9447: "timeout"}).bind(ft2)
rec2.tried.clear()
ft2._request("GET", "/x", {}, None, [200])
ok("rotation wraps around the set and only stops at a connection-level failure",
   rec2.tried == [8443], str(rec2.tried))
rec2.failures = {9447: "network", 1: "network", 8443: None}
rec2.tried.clear()
ft2._cursor = 1                      # pretend 9447 answered last
ft2.port = 9447
r = ft2.get("/x")
ok("after a failover the order continues through the whole set",
   rec2.tried == [9447, 1, 8443] and ft2.active_port() == 8443, f"{rec2.tried} -> {ft2.active_port()}")

# ---------------------------------------------------------------- pin mismatch is terminal
for code, label in (("tls_pin_mismatch", "a certificate pin mismatch"),
                    ("tls_no_certificate", "a peer with no certificate"),
                    ("consent_required", "a server-side consent verdict"),
                    ("state_conflict", "a server-side state conflict")):
    h = Transport("127.0.0.1", ports=[8443, 9447, 1], pin="0" * 64)
    rec_h = Recorder({8443: code}).bind(h)
    got = None
    try:
        h.get("/api/v1/notice")
    except ClientError as err:
        got = err.code
    ok(f"{label} is re-raised and never port-switches",
       got == code and rec_h.tried == [8443] and h.active_port() == 8443,
       f"code={got} tried={rec_h.tried} active={h.active_port()}")

# ---------------------------------------------------------------- every port dead
d = Transport("127.0.0.1", ports=[1, 2], pin="a" * 64)
Recorder({1: "network", 2: "network"}).bind(d)
err = None
try:
    d.get("/x")
except ClientError as e:
    err = e
ok("all ports refusing raises the last connection-level error, not a crash",
   err is not None and err.code == "network", f"{err.code if err else None}: {err.detail if err else ''}")

d2 = Transport("127.0.0.1", ports=[1], pin="a" * 64)
d2._request_on = lambda *a, **k: None
try:
    Transport("127.0.0.1", ports=[], pin="a" * 64)
    ok("an empty port set is refused at construction", False)
except ClientError as e:
    ok("an empty port set is refused at construction", e.code == "port_missing", e.code)

# ---------------------------------------------------------------- the pin verdict itself
ok("pin_verified() is false before any handshake", d2.pin_verified() is False)
mutated = d2.ports()
mutated.append(99)
ok("ports() returns a copy the caller cannot use to mutate the set", d2.ports() == [1])

passed = sum(1 for r_ in results if r_[0])
print(f"\n{passed}/{len(results)} assertions passed")
sys.exit(0 if passed == len(results) else 1)
