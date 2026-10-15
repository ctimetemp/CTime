import hashlib
import os

from .machine_id import persisted_fallback_id, read_machine_guid, smb_uuid


def device_fingerprint(state_dir):
    """Identifies the device, not the person, and is stable across reinstalls and OS renames.
    Every input here is readable by anyone with access to the machine, so the fingerprint is not a
    secret and is never an authenticator on its own -- the bearer token is."""
    guid = read_machine_guid()
    source = ({"id": guid, "source": "registry"} if guid
              else persisted_fallback_id(os.path.join(state_dir, "machine-id.fallback")))
    parts = [source["id"]]
    machine_uuid = smb_uuid()
    if machine_uuid:
        parts.append(machine_uuid)
    return {
        "fingerprint": hashlib.sha256("|".join(parts).encode()).hexdigest(),
        "source": source["source"],
        "has_smb_uuid": bool(machine_uuid),
    }
