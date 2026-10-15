import json
import os
import platform

# All client state lives in one discoverable directory. Nothing is hidden and uninstall removes
# exactly this tree.
DEFAULT_TASK_NAME = "CTTIme Endpoint Visibility"


def resolve_state_dir(override=None):
    if override:
        return os.path.abspath(override)
    program_data = os.environ.get("PROGRAMDATA") or "C:\\ProgramData"
    return os.path.join(program_data, "CTTIme")


def paths(state_dir):
    return {
        "root": state_dir,
        "config": os.path.join(state_dir, "config.json"),
        "spool": os.path.join(state_dir, "spool"),
        "log": os.path.join(state_dir, "agent.log"),
        "token": os.path.join(state_dir, "token.bin"),
        "identity": os.path.join(state_dir, "identity.json"),
        "policy": os.path.join(state_dir, "policy.json"),
        "pending": os.path.join(state_dir, "pending-shots"),
    }


def ensure_layout(p):
    for key in ("root", "spool", "pending"):
        os.makedirs(p[key], exist_ok=True)


def read_json_file(file, fallback=None):
    try:
        with open(file, encoding="utf8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def write_json_file(file, value):
    # Direct write, as on the Node client: Windows refuses to rename over an existing target, so
    # an atomic-rename dance would need a delete first and widen the corrupt window instead.
    with open(file, "w", encoding="utf8") as fh:
        fh.write(json.dumps(value, indent=2))


def _arch():
    machine = platform.machine()
    return {"AMD64": "x64", "ARM64": "arm64", "x86": "x86"}.get(machine, machine)


def device_identity():
    return {
        "hostname": os.environ.get("COMPUTERNAME") or platform.node(),
        "os_build": f"{platform.version()} {_arch()}",
        # Taken from the environment rather than typed so it can be cross-checked against the
        # acknowledgment name at enrollment.
        "device_user": os.environ.get("USERNAME") or os.environ.get("USER") or "unknown",
    }
