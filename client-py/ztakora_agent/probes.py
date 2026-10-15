import json
import os
import subprocess
import sys

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def probe_dir():
    base = getattr(sys, "_MEIPASS", None)
    if base:
        # build-exe.py keeps the package layout inside the bundle, so the probes sit at the same
        # relative path a source checkout has them at. Pointing straight at _MEIPASS would look
        # for a probes folder that is one level too high and every capture would fail silently.
        return os.path.join(base, "CTTIme_agent", "probes")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "probes")


def run(script, *, args=(), stdin_text=None, timeout=30, sta=False):
    """Runs one of the PowerShell children. Screen capture, clipboard sampling and DPAPI stay in
    PowerShell because those are the audited code paths, they need no native module in Python, and
    the clipboard hash never has to re-enter this process."""
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]
    if sta:
        cmd.append("-STA")
    script_path = os.path.join(probe_dir(), script)
    if not os.path.exists(script_path):
        # A bad bundle otherwise looks like a sensor that quietly returns nothing.
        return {"ok": False, "error": f"{script} is not present at {script_path}"}
    cmd += ["-File", script_path, *[str(a) for a in args]]
    try:
        proc = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout,
                              creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{script} timed out after {timeout}s"}
    except OSError as err:
        return {"ok": False, "error": str(err)}
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 and not out:
        return {"ok": False, "error": ((proc.stderr or "").strip() or f"exit {proc.returncode}")[:200]}
    return {"ok": True, "stdout": out, "returncode": proc.returncode,
            "stderr": (proc.stderr or "").strip()}


def run_json(script, **kwargs):
    result = run(script, **kwargs)
    if not result["ok"]:
        return None, result["error"]
    try:
        return json.loads(result["stdout"]), None
    except ValueError as err:
        # The raw output is deliberately not included: for the clipboard probe this is exactly the
        # place a leak would appear.
        return None, f"unparseable probe output ({err})"
