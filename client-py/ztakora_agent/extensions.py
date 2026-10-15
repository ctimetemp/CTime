import hashlib
import json
import math
import os
import re

# Read-only inventory of installed browser extensions. Nothing is written, nothing outside the
# browser's own profile directories is read, and the file-hash gate means a large "Secure
# Preferences" is parsed about once a day per device rather than on every heartbeat.

CHROMIUM_BROWSERS = [
    ("chrome", ["Google", "Chrome", "User Data"]),
    ("brave", ["BraveSoftware", "Brave-Browser", "User Data"]),
    ("edge", ["Microsoft", "Edge", "User Data"]),
]
FIREFOX_DIR = ["Mozilla", "Firefox", "Profiles"]
PROFILE_RE = re.compile(r"^(Default|Profile \d+)$")

# Shipped with the browser and carrying no third-party permissions, so they are not the signal the
# dashboard is about: what the user added.
IGNORED_IDS = frozenset({
    "nmmhkkegccagdldgiimedpiccmgmieda",  # Google Wallet
    "fheoggkfdfchfphceeifdbepaooicaho",  # Chrome Website Verifier
})


def file_gist(file):
    try:
        stat = os.stat(file)
        with open(file, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        return f"{math.floor(stat.st_mtime * 1000 + 0.5)}|{stat.st_size}|{digest}"
    except OSError:
        return None


def _chromium_profiles(user_data_dir):
    out = []
    if not os.path.isdir(user_data_dir):
        return out
    for entry in os.scandir(user_data_dir):
        if not entry.is_dir() or not PROFILE_RE.match(entry.name):
            continue
        # Everything else in User Data (Local State, Crashpad, GrShaderCache) is not a profile.
        if os.path.exists(os.path.join(user_data_dir, entry.name, "Preferences")):
            out.append(entry.name)
    return out


def _read_chromium_settings(profile_dir):
    # Secure Preferences is the signed copy and can exceed 5 MiB; Preferences is the unsigned one.
    for name in ("Secure Preferences", "Preferences"):
        file = os.path.join(profile_dir, name)
        if not os.path.exists(file):
            continue
        try:
            with open(file, encoding="utf8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        settings = (doc or {}).get("extensions", {}).get("settings") if isinstance(doc, dict) else None
        if isinstance(settings, dict):
            return settings, file
    return None


def _map_chromium(ext_id, entry):
    if not isinstance(entry, dict):
        return None
    contents = entry.get("contents") or {}
    state = entry.get("state")
    name = contents.get("name") if isinstance(contents, dict) else None
    from_manifest = name or entry.get("path") or ext_id
    permissions = entry.get("permissions")
    if not isinstance(permissions, list):
        permissions = contents.get("permissions") if isinstance(contents, dict) else None
    if not isinstance(permissions, list):
        permissions = []
    source = "unknown"
    if isinstance(entry.get("path"), str) and entry["path"] != "":
        source = "sideload"
    elif entry.get("fromWebstore") is not False and (state == 1 or state is None):
        source = "webstore"
    elif entry.get("location") == 10:
        source = "builtin"
    if entry.get("source") in ("webstore", "local", "sideload"):
        source = entry["source"]
    return {
        "ext_id": ext_id,
        "name": str(from_manifest)[:512],
        "version": str(contents["version"])[:128] if isinstance(contents, dict)
        and contents.get("version") else None,
        "source": source,
        "permissions": [str(p)[:256] for p in permissions[:64]],
        # Chrome state: 1 = enabled, 0 = disabled, anything else (or missing) is not enabled.
        "enabled": entry.get("enabled") is True or state == 1,
    }


def _collect_chromium(local_app_data, override_root):
    results = []
    for browser, parts in CHROMIUM_BROWSERS:
        userData = os.path.join(override_root, "Local", *parts) if override_root \
            else os.path.join(local_app_data, *parts) if local_app_data else ""
        if not userData or not os.path.isdir(userData):
            continue
        for profile in _chromium_profiles(userData):
            found = _read_chromium_settings(os.path.join(userData, profile))
            if not found:
                continue
            settings, file = found
            extensions = []
            for ext_id, entry in settings.items():
                if ext_id in IGNORED_IDS:
                    continue
                mapped = _map_chromium(ext_id, entry)
                if mapped:
                    extensions.append(mapped)
            results.append({"browser": browser, "profile": profile, "extensions": extensions,
                            "source_file": file, "gist": file_gist(file)})
    return results


def _collect_firefox(app_data, override_root):
    results = []
    root = os.path.join(override_root, "Roaming", *FIREFOX_DIR) if override_root \
        else os.path.join(app_data, *FIREFOX_DIR) if app_data else ""
    if not root or not os.path.isdir(root):
        return results
    for entry in os.scandir(root):
        if not entry.is_dir():
            continue
        file = os.path.join(entry.path, "extensions.json")
        if not os.path.exists(file):
            continue
        try:
            with open(file, encoding="utf8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        addons = (doc or {}).get("addons") if isinstance(doc, dict) else None
        extensions = []
        for addon in addons or []:
            if not isinstance(addon, dict) or addon.get("id") in IGNORED_IDS:
                continue
            # appDisabled/userDisabled are Firefox's own enabled flags.
            extensions.append({
                "ext_id": str(addon.get("id"))[:256],
                "name": str(addon.get("name") or addon.get("id"))[:512],
                "version": str(addon["version"])[:128] if addon.get("version") else None,
                "source": "builtin" if addon.get("builtIn")
                else "local" if str(addon.get("rootURI", "")).startswith("file:") else "webstore",
                "permissions": [str(p)[:256] for p in (addon.get("permissions") or [])[:64]],
                "enabled": addon.get("appDisabled") is not True and addon.get("userDisabled") is not True,
            })
        if not extensions:
            continue
        results.append({"browser": "firefox", "profile": entry.name, "extensions": extensions,
                        "source_file": file, "gist": file_gist(file)})
    return results


def read_extension_inventory():
    """One entry per (browser, profile) that has extension data, each carrying a `gist` the caller
    stores so an unchanged profile is not re-uploaded. A missing browser is the normal case, not an
    error, and neither reader may crash the agent."""
    local_app_data = os.environ.get("LOCALAPPDATA") or ""
    app_data = os.environ.get("APPDATA") or ""
    out = []
    try:
        out += _collect_chromium(local_app_data, None)
    except OSError:
        pass
    try:
        out += _collect_firefox(app_data, None)
    except OSError:
        pass
    return out
