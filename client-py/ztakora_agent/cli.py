import argparse
import json
import os
import re
import sys

from . import AGENT_VERSION
from .agent import Agent
from .errors import ClientError
from .state import paths, read_json_file, resolve_state_dir

# The client is a normal, named, discoverable program. `--help` works, the state directory is
# documented, and there is no flag that hides any of it -- an installer that wanted invisibility
# would need code that does not exist here.

USAGE = f"""CTTIme agent {AGENT_VERSION}

Commands
  run            Enroll if needed, then collect and flush on the server's schedule.
  one-shot       Fetch policy, take one of each sample, flush, and exit. For verification.
  status         Print local state: enrollment, spool depth, policy in effect, dropped count.
  what-collects  Print exactly what this device collects and how often it leaves.
  check          Verify connectivity, pin, notice and enrollment state without collecting.

Options
  --host <addr>            Collector host or LAN IP. (required for run/one-shot/check)
  --port <n[,n]>           Collector port(s), tried in order. (default 8443)
  --pin <hex64>            SHA-256 fingerprint of the collector certificate. Required; no fallback.
  --state-dir <dir>        Override %PROGRAMDATA%\\CTTIme. Use for testing on a dev box.
  --acknowledge-by <name>  Supply the acknowledgment non-interactively. The notice text is still
                           printed first unless --no-notice.
  --no-notice              Do not print the notice text when acknowledging non-interactively.
  --interactive            Prompt for acknowledgment on stdin.
  --resident               Scheduled-task mode: opens no console window. Affects the window only --
                           the named task, config.json, agent.log and what-collects are unchanged,
                           and a run without it (yours, by hand) keeps its window.
  --verbose                Echo the local log to stdout.
"""

NETWORK_COMMANDS = ("run", "one-shot", "check")


def parse_ports(value):
    """`--port 8443,9447` is the collector's listener set, tried in order. Same split the Node CLI
    uses; entries that are not whole numbers are dropped rather than guessed at, and the transport
    refuses the request outright if nothing usable is left."""
    entries = [item for item in re.split(r"[,;\s]+", str(value if value is not None else "").strip())
               if item]
    ports = []
    for entry in entries:
        try:
            ports.append(int(entry, 10))
        except ValueError:
            continue
    return ports


def _parser():
    parser = argparse.ArgumentParser(prog="CTTImeAgent", add_help=False,
                                     description=USAGE, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="help")
    parser.add_argument("--host")
    parser.add_argument("--port", default="8443")
    parser.add_argument("--pin")
    parser.add_argument("--state-dir", dest="state_dir")
    parser.add_argument("--acknowledge-by", dest="acknowledge_by")
    parser.add_argument("--no-notice", dest="show_notice", action="store_false", default=True)
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--resident", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--help", "-h", dest="help", action="store_true")
    return parser


def main(argv):
    parser = _parser()
    try:
        args, unknown = parser.parse_known_args(argv)
    except (argparse.ArgumentError, SystemExit) as err:
        sys.stderr.write(f"! {err}\n")
        return 2
    if unknown:
        sys.stderr.write(f"! unknown option {unknown[0]}\n")
        return 2
    command = "help" if args.help else (args.command or "help")
    if command == "help":
        sys.stdout.write(USAGE)
        return 0
    if command == "what-collects":
        return what_collects(args)
    if command == "status":
        return status(args)
    if command not in NETWORK_COMMANDS:
        sys.stderr.write(USAGE)
        return 2
    if not args.host:
        sys.stderr.write("! --host is required\n")
        return 2
    if not args.pin:
        sys.stderr.write("! --pin is required. The collector prints it at startup.\n")
        return 2

    ports = parse_ports(args.port)
    opts = {"host": args.host, "ports": ports, "port": ports[0] if ports else 8443,
            "pin": args.pin, "state_dir": args.state_dir,
            "acknowledge_by": args.acknowledge_by, "show_notice": args.show_notice,
            "interactive": args.interactive, "verbose": args.verbose,
            "resident": args.resident,
            "one_shot": command == "one-shot"}
    agent = Agent(opts)
    result = agent.check() if command == "check" else agent.run()
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 1 if result.get("status") == "check_failed" else 0


def what_collects(args):
    p = paths(resolve_state_dir(args.state_dir))
    config = read_json_file(p["config"])
    if config is None:
        sys.stdout.write("Not installed or never run on this machine: no config.json yet.\n")
        sys.stdout.write(f"Expected at {p['config']}\n")
        return 1
    sys.stdout.write("What this agent collects on this device\n")
    sys.stdout.write("=========================================\n")
    sys.stdout.write(json.dumps(config, indent=2) + "\n\n")
    sys.stdout.write(f"Local log:      {p['log']}\n")
    sys.stdout.write(f"Spool:          {p['spool']}\n")
    sys.stdout.write("Scheduled task: CTTIme Endpoint Visibility (visible in schtasks /query)\n")
    sys.stdout.write("Uninstall:      scripts/uninstall.ps1\n")
    return 0


def status(args):
    p = paths(resolve_state_dir(args.state_dir))
    identity = read_json_file(p["identity"])
    policy = read_json_file(p["policy"])
    # Whether the agent actually told the person at this keyboard something. Read from the file the
    # notifier writes, so it is true after the process has left and cannot be claimed from memory.
    notices = read_json_file(os.path.join(p["pending"], "notifications.json"))
    history = (notices or {}).get("history") or []
    sys.stdout.write(json.dumps({
        "state_dir": p["root"],
        "installed": read_json_file(p["config"]) is not None,
        "enrolled": bool((identity or {}).get("device_id")),
        "device_id": (identity or {}).get("device_id"),
        "has_sealed_token": os.path.exists(p["token"]),
        "policy_etag": (policy or {}).get("etag"),
        "policy_keys": len((policy or {}).get("values") or {}),
        "spool_dir": p["spool"],
        "notices_to_device_user": {
            "shown": (notices or {}).get("sent") or 0,
            "failed": (notices or {}).get("failed") or 0,
            "last": history[0] if history else None,
        },
    }, indent=2) + "\n")
    return 0
