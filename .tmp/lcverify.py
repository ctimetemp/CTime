"""Lifecycle harness for the resident-agent fix.

Proves, against two throwaway collectors on scratch ports with their own data directories:
  * an agent whose gates are shut STAYS ALIVE and re-checks instead of exiting;
  * an acknowledgment typed by a separate process and an approval clicked over the admin API are
    both picked up by the already-running process, with no restart;
  * the collector then has real rows for that device;
  * a decline is terminal, and a scripted acknowledgment cannot walk a decline back;
  * one-shot still returns immediately (it is a verification command, not a daemon).

Nothing here touches server/data/collector.db, and the acknowledgment name is an obviously
synthetic value used only against these scratch collectors.
"""
import atexit
import hashlib
import http.client
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import time

ROOT = r"D:\CTTIme"
TMP = os.path.join(ROOT, ".tmp")
ADMIN_PASS = "lifecycle-harness-pass-1"


def kill_tree(pid):
    """Terminate a spawned process *and its children*.

    `node` on this host's PATH is the nvm shim: Popen.terminate() kills the shim and leaves the
    real node.exe holding the port and writing to the scratch state dir. An orphan agent from an
    earlier run appends to the same agent.log with an obsolete pin, so its tls_pin_mismatch lines
    read as if the process under test were failing. taskkill /T is the only reliable way to drop
    the whole tree on Windows.
    """
    if pid is None:
        return
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, text=True)


def port_is_free(port):
    """A scratch collector must own its port. Binding failure is not retried by the server, so a
    silently-crashed collector would leave the harness talking to a stale one."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))
    return ok


def note(text):
    print(f"      {text}")


def ctx():
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def call(port, method, path, body=None, headers=None, timeout=20):
    conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=timeout, context=ctx())
    hdrs = dict(headers or {})
    payload = None
    if body is not None:
        payload = json.dumps(body)
        hdrs["content-type"] = "application/json"
    conn.request(method, path, payload, hdrs)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw.decode("utf8", "replace")
    return res.status, parsed, {k.lower(): v for k, v in res.getheaders()}


def login(port):
    for attempt in range(30):
        try:
            status, body, _ = call(port, "POST", "/api/login",
                                   {"account": "lcadmin", "password": ADMIN_PASS})
            if status == 200:
                return body["csrf"]
            if status == 401:
                return None
        except OSError:
            pass
        time.sleep(0.5)
    return None


def served_fingerprint(port):
    """SHA-256 of the DER certificate the port actually presents -- what both clients pin."""
    tcp = socket.create_connection(("127.0.0.1", port), 10)
    try:
        tls = ctx().wrap_socket(tcp, server_hostname=None)
        der = tls.getpeercert(binary_form=True)
        tls.close()
        return hashlib.sha256(der).hexdigest() if der else ""
    finally:
        tcp.close()


class Collector:
    def __init__(self, port):
        self.port = port
        self.data = os.path.join(TMP, f"lcdata{port}")
        self.proc = None

    def start(self):
        if not port_is_free(self.port):
            raise RuntimeError(
                f"port {self.port} is already listening: a collector from an earlier run survived "
                "it (PATH node.exe is the nvm shim, so terminate() can leave the real child up). "
                "Talking to it would test the wrong certificate and the wrong database.")
        shutil.rmtree(self.data, ignore_errors=True)
        env = dict(os.environ, CTTIme_DATA=self.data, CTTIme_BIND="127.0.0.1",
                   CTTIme_PORT=str(self.port),
                   CTTIme_BOOTSTRAP_ACCOUNT=f"lcadmin:{ADMIN_PASS}")
        self.proc = subprocess.Popen(["node", "server\\index.js"], cwd=ROOT, env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        csrf = login(self.port)
        if not csrf:
            raise RuntimeError(f"collector on {self.port} never accepted the scratch admin")
        self.csrf = csrf
        with open(os.path.join(self.data, "tls", "fingerprint.txt"), encoding="utf8") as fh:
            self.pin = fh.read().strip()
        # The fingerprint file and the certificate actually served must agree, otherwise every
        # agent in this run would be pinning something the collector never presents.
        if served_fingerprint(self.port) != self.pin:
            raise RuntimeError(
                f"collector on {self.port} serves a certificate the fingerprint file does not "
                "describe -- this port is held by a process that is not the one just spawned")
        # A crash half-way through must not leave a collector bound to a port and a scratch
        # database on disk behind it.
        atexit.register(self.stop)
        return self

    def stop(self):
        # kill_tree, not terminate: the shim dies and the real node.exe keeps the port.
        kill_tree(self.proc.pid if self.proc else None)
        self.proc = None
        shutil.rmtree(self.data, ignore_errors=True)


class AgentRun:
    """Launches one client's `run` as its own process and reads only its plaintext log."""

    def __init__(self, kind, port, pin, state_dir):
        self.kind = kind
        self.port = port
        self.pin = pin
        self.state = state_dir
        self.proc = None

    def start(self, extra=()):
        shutil.rmtree(self.state, ignore_errors=True)
        os.makedirs(self.state, exist_ok=True)
        if self.kind == "python":
            cmd = [sys.executable, "-m", "CTTIme_agent", "run", "--host", "127.0.0.1",
                   "--port", str(self.port), "--pin", self.pin, "--state-dir", self.state]
            cwd = os.path.join(ROOT, "client-py")
            env = dict(os.environ, PYTHONPATH=cwd)
        else:
            cmd = ["node", "cli.js", "run", "--host", "127.0.0.1", "--port", str(self.port),
                   "--pin", self.pin, "--state-dir", self.state]
            cwd = os.path.join(ROOT, "agent")
            env = dict(os.environ)
        self.cmd = list(cmd) + list(extra)
        self.proc = subprocess.Popen(self.cmd, cwd=cwd, env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, encoding="utf8", errors="replace")
        atexit.register(self.stop)
        return self

    def log(self):
        path = os.path.join(self.state, "agent.log")
        try:
            with open(path, encoding="utf8") as fh:
                return fh.read()
        except OSError:
            return ""

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def wait_for(self, needle, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if needle in self.log():
                return True
            if not self.alive() and needle != "not collecting":
                return False
            time.sleep(0.5)
        return needle in self.log()

    def stop(self):
        # kill_tree, not terminate: killing the nvm shim leaves the real node.exe running with the
        # scratch state dir open, and its stale-pin log lines land in the same agent.log.
        kill_tree(self.proc.pid if self.proc else None)
        self.proc = None


def enroll_one_shot(port, pin, state_dir):
    """Enroll as a separate, deliberate act: this is the acknowledgment step, done by a process
    that exists only to type a name into the notice on a scratch collector."""
    shutil.rmtree(state_dir, ignore_errors=True)
    os.makedirs(state_dir, exist_ok=True)
    cmd = [sys.executable, "-m", "CTTIme_agent", "one-shot", "--host", "127.0.0.1",
           "--port", str(port), "--pin", pin, "--state-dir", state_dir,
           "--acknowledge-by", "Scratch Test Device User"]
    proc = subprocess.run(cmd, cwd=os.path.join(ROOT, "client-py"),
                          env=dict(os.environ, PYTHONPATH=os.path.join(ROOT, "client-py")),
                          capture_output=True, text=True, encoding="utf8", errors="replace",
                          timeout=180)
    return proc.stdout + proc.stderr


def pending_ids(port, session):
    status, body, _ = call(port, "GET", "/api/devices?state=pending_approval", None,
                           {"cookie": f"CTTIme_session={session}"})
    if status != 200:
        raise RuntimeError(f"devices query returned {status}: {json.dumps(body)[:200]}")
    return [d["id"] for d in (body or {}).get("items", [])]


def device(port, session, device_id):
    status, body, _ = call(port, "GET", f"/api/devices/{device_id}", None,
                           {"cookie": f"CTTIme_session={session}"})
    if status != 200:
        raise RuntimeError(f"device detail returned {status}: {json.dumps(body)[:200]}")
    # GET /api/devices/:id answers {device, counts, policy_stale, ...} — the row is nested.
    return (body or {}).get("device") or {}


def tail(log_text, lines=3):
    rows = [l for l in (log_text or "").strip().splitlines() if l]
    return " | ".join(rows[-lines:]) if rows else "(empty log)"


def approve(port, csrf, session, device_id):
    return call(port, "POST", f"/api/devices/{device_id}/approve", {},
                {"x-csrf-token": csrf, "cookie": f"CTTIme_session={session}"})


def session_pair(port):
    c = http.client.HTTPSConnection("127.0.0.1", port, timeout=20, context=ctx())
    c.request("POST", "/api/login", json.dumps({"account": "lcadmin", "password": ADMIN_PASS}),
              {"content-type": "application/json"})
    r = c.getresponse()
    raw = json.loads(r.read())
    headers = r.getheaders()
    c.close()
    session = None
    for k, v in headers:
        if k.lower() == "set-cookie":
            session = v.split(";")[0].split("=", 1)[1]
    if not session:
        raise RuntimeError(f"login on {port} set no session cookie")
    return session, raw["csrf"]


def decline_scenario(port, pin, session):
    """A decline is terminal, and a scripted acknowledgment cannot undo it.

    This gets its own collector because device identity on this box comes from the registry
    MachineGuid, so every scratch state dir on the host resolves to the *same* fingerprint. On a
    database that has already seen and approved that fingerprint, a scripted `--acknowledge-by`
    would legitimately be refused for `token_issuance_missed` instead of testing the decline.
    """
    state = os.path.join(TMP, f"lcdecline{port}")
    shutil.rmtree(state, ignore_errors=True)
    os.makedirs(state, exist_ok=True)
    base = [sys.executable, "-m", "CTTIme_agent", "one-shot", "--host", "127.0.0.1",
            "--port", str(port), "--pin", pin, "--state-dir", state]
    run_env = dict(os.environ, PYTHONPATH=os.path.join(ROOT, "client-py"))
    decl = subprocess.run(base + ["--interactive"], input="no\n", capture_output=True,
                          text=True, timeout=180, cwd=os.path.join(ROOT, "client-py"), env=run_env)
    out = decl.stdout + decl.stderr
    marker = os.path.exists(os.path.join(state, "DECLINED.txt"))
    check("decline writes DECLINED.txt and collects nothing",
          marker and "declined" in out and not pending_ids(port, session),
          f"marker={marker} out={[l.strip() for l in out.splitlines() if 'declin' in l.lower()][:2]}")
    retry = subprocess.run(base + ["--acknowledge-by", "Someone Else"],
                           capture_output=True, text=True, timeout=180,
                           cwd=os.path.join(ROOT, "client-py"), env=run_env)
    out2 = retry.stdout + retry.stderr
    check("a scripted acknowledgment cannot walk back a decline",
          "declined" in out2 and os.path.exists(os.path.join(state, "DECLINED.txt"))
          and not pending_ids(port, session),
          f"status line: {[l.strip() for l in out2.splitlines() if 'status' in l][:1]}")
    shutil.rmtree(state, ignore_errors=True)


def main():
    print("\nResident agent lifecycle\n")
    # One collector per scenario: see decline_scenario for why a shared fingerprint needs it.
    py_port, node_port, decline_port = 8455, 8456, 8457
    col_py = Collector(py_port).start()
    col_node = Collector(node_port).start()
    col_dec = Collector(decline_port).start()
    py_session, py_csrf = session_pair(py_port)
    node_session, node_csrf = session_pair(node_port)

    # --- python client: the gate is shut, the process must stay up -------------------------
    a = AgentRun("python", py_port, col_py.pin, os.path.join(TMP, "lcstate-py")).start()
    check("python: stays resident while consent is outstanding",
          a.wait_for("not collecting", 40) and a.alive(), f"log tail: {tail(a.log())}")

    # --- the acknowledgment happens in a second, deliberate process ------------------------
    out = enroll_one_shot(py_port, col_py.pin, os.path.join(TMP, "lcpaire"))
    ids = pending_ids(py_port, py_session)
    check("python: the acknowledgment enrolled a pending device", bool(ids), f"pending: {len(ids)}")
    if not ids:
        note(f"enroll output: {out[-300:]}")

    time.sleep(3)
    check("python: still the same process after enrollment", a.alive())

    # --- approval over the admin API, then the WAITING process must notice -----------------
    ok = approve(py_port, py_csrf, py_session, ids[0])
    check("python: admin approval accepted", ok[0] == 200, json.dumps(ok[1]))
    picked = a.wait_for("agent running", 90)
    check("python: the already-running agent picked up approval with no restart", picked,
          "waited 90s for 'agent running'" if not picked else tail(a.log()))
    check("python: agent sealed its token", "token sealed" in a.log(), tail(a.log()))
    check("python: still resident after going live", a.alive())

    time.sleep(6)
    dev = device(py_port, py_session, ids[0])
    check("collector: it recorded a heartbeat from the device",
          bool(dev.get("last_seen_at")),
          f"last_seen={dev.get('last_seen_at')} bytes_sent={dev.get('bytes_sent')}")
    note(f"device: {json.dumps({k: v for k, v in dev.items() if isinstance(v, (int, str))})[:400]}")
    a.stop()

    # --- node client: same lifecycle expectations ------------------------------------------
    b = AgentRun("node", node_port, col_node.pin, os.path.join(TMP, "lcstate-node")).start()
    check("node: stays resident while consent is outstanding",
          b.wait_for("not collecting", 40) and b.alive(), f"log tail: {tail(b.log())}")
    outn = enroll_one_shot(node_port, col_node.pin, os.path.join(TMP, "lcpairnode"))
    idsn = pending_ids(node_port, node_session)
    check("node: enrollment landed on the second collector", bool(idsn), f"pending: {len(idsn)}")
    if not idsn:
        note(f"enroll output: {outn[-300:]}")
    approven = approve(node_port, node_csrf, node_session, idsn[0])
    check("node: admin approval accepted", approven[0] == 200, json.dumps(approven[1]))
    gotlive = b.wait_for("agent running", 90)
    check("node: the already-running agent picked up approval with no restart", gotlive,
          tail(b.log(), 8) if not gotlive else tail(b.log()))
    check("node: still resident after going live (unref'd-timer fix)", b.alive(),
          "the old build exited by itself once its timers were unref'd")
    time.sleep(6)
    devn = device(node_port, node_session, idsn[0])
    check("node: collector recorded a heartbeat from it", bool(devn.get("last_seen_at")),
          f"last_seen={devn.get('last_seen_at')} bytes_sent={devn.get('bytes_sent')}")
    b.stop()

    # --- a decline is terminal, and a script cannot undo it --------------------------------
    dec_session, _dec_csrf = session_pair(decline_port)
    decline_scenario(decline_port, col_dec.pin, dec_session)

    for col in (col_py, col_node, col_dec):
        col.stop()
    for name in ("lcstate-py", "lcstate-node", "lcpaire", "lcpairnode"):
        shutil.rmtree(os.path.join(TMP, name), ignore_errors=True)

    print(f"\n{sum(results)}/{len(results)} lifecycle checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
