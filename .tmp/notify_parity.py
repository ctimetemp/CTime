"""Byte-parity check: client-py notify.py vs the live agent/lib/notify.js."""
import json
import sys

sys.path.insert(0, r"D:\CTTIme\client-py")
from CTTIme_agent import notify  # noqa: E402

with open(r"D:\CTTIme\.tmp\node-notify-dump.json", encoding="utf-8") as fh:
    node = json.load(fh)

ok = True

same_alerts = node["alerts"] == notify.ALERTS
same_order = list(node["alerts"]) == list(notify.ALERTS)
same_script = node["script"] == notify.SCRIPT
print("ALERTS identical:", same_alerts)
print("key order identical:", same_order)
print("SCRIPT identical:", same_script, len(node["script"]), len(notify.SCRIPT))
ok = ok and same_alerts and same_order and same_script

bounds = {k: (len(v["title"]), len(v["text"])) for k, v in notify.ALERTS.items()}
print("title/text lengths:", bounds)
bad = {k: v for k, v in bounds.items() if v[0] > notify.MAX_TITLE or v[1] > notify.MAX_TEXT}
print("over the 63/240 bounds:", bad or "none")
ok = ok and not bad

print("per-kind windows (s):", {k: int(v) for k, v in notify.WINDOWS.items()},
      "floor:", notify.MAX_TITLE and 60)
expect_windows = {"collecting": 20 * 3600, "registered": 6 * 3600, "approved": 6 * 3600}
for kind, secs in expect_windows.items():
    if notify.WINDOWS.get(kind) != secs:
        print("WINDOW MISMATCH", kind, notify.WINDOWS.get(kind), secs)
        ok = False
n = notify.Notifier(r"D:\CTTIme\.tmp\notifyparity", log=lambda *a: None)
for kind in node["alerts"]:
    if n.window_for(kind) != max(60, expect_windows.get(kind, 60)):
        print("window_for wrong for", kind, n.window_for(kind))
        ok = False

if list(notify.ALERTS) != ["online", "offline", "unverified", "registered", "approved", "collecting"]:
    print("ALERTS order unexpected:", list(notify.ALERTS))
    ok = False

# placeholders must resolve for every kind with the fields the agent passes
fills = {
    "collecting": {"screenshots": 41, "events": 118, "dropped": 3, "since": "40m"},
    "registered": {"machine": "DESKTOP-X", "model": "ThinkPad T14", "user": "alice"},
    "approved": {"machine": "DESKTOP-X", "user": "alice"},
    "offline": {"minutes": 12}, "online": {}, "unverified": {},
}
for kind, fields in fills.items():
    a = notify.ALERTS[kind]
    t = notify.fill(a["title"], fields)
    x = notify.fill(a["text"], fields)
    if "{" in t or "{" in x:
        print("UNFILLED PLACEHOLDER", kind, t, x)
        ok = False
    print(f"  {kind}: title={t!r}")
    print(f"     text=  {x!r}")

print("PARITY:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
