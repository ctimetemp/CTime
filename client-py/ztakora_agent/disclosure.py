import json
import os

from . import AGENT_VERSION


def write_disclosure_config(p, policy, opts, state_dir, ident):
    """The plaintext file the device user can open. It is rewritten whenever policy changes so the
    answer to "what is this machine doing right now" never goes stale."""
    v = policy.values
    config = {
        "product": "CTTIme Endpoint Visibility",
        "purpose": "Disclosed endpoint monitoring on a company-managed Windows device.",
        "agent_version": AGENT_VERSION,
        "state_directory": state_dir,
        # Static disclosure only: which addresses this device was told to trust. Which one a request
        # actually landed on is a live fact and `check` reports it.
        "collector": {
            "host": opts["host"],
            "ports": (opts.get("ports") or []) or [opts.get("port") or 8443],
            "transport": "https, pinned by certificate SHA-256 fingerprint",
        },
        "collects": {
            "screenshots": {
                "enabled": True,
                "every_minutes": v["screenshot_interval_minutes"],
                "skipped_when_locked": v["skip_when_locked"],
                "skipped_when_idle_seconds_over": v["idle_skip_seconds"],
                "identical_frames_uploaded": v["dedupe_unchanged_frames"] is False,
                "server_side_retention_days": v["screenshot_retention_days"],
            },
            "browser_extensions": {
                "enabled": v["extension_inventory_enabled"],
                "browsers": ["chrome", "brave", "edge", "firefox"],
                "how_often": f"at most once per {v['ext_inventory_max_age_hours']}h, and only "
                             "when a browser preference file changed",
            },
            "clipboard": {
                "enabled": v["clipboard_metrics_enabled"],
                "every_seconds": v["clipboard_sample_seconds"],
                "sent": "character count, SHA-256 of the content, kind label "
                        "(text|file-list|image|empty)",
                "never_sent": "the clipboard content. It is hashed inside a child process and "
                              "discarded.",
            },
            "screen_state": {"enabled": True, "values": ["locked", "idle", "active"]},
        },
        # Part of the disclosure, not a footnote: the agent appears on the device user's own screen
        # when the link to the collector changes. `what-collects` prints this so the answer to "what
        # does that popup mean" is available offline, in the same command that lists the collection.
        "device_user_notices": {
            "shown_on_screen": True,
            "when": ["the collector became unreachable",
                     "the collector is reachable again after a gap",
                     "the collector certificate did not match the pin this device was given"],
            "wording": "factual: what changed, what it means for the data buffered on this machine, "
                       "who to tell",
            "history": "the last twenty notices are recorded in "
                       "<state dir>\\pending-shots\\notifications.json",
            "never": "a prompt to approve anything. The notice and its acknowledgment are separate.",
        },
        "batching": {
            "model": "events append to a local spool and upload in batches; nothing is sent per "
                     "event",
            "heartbeat_interval_seconds": v["heartbeat_interval_seconds"],
            "batch_max_items": v["batch_max_items"],
            "batch_max_bytes": v["batch_max_bytes"],
            "batch_max_age_seconds": v["batch_max_age_seconds"],
            "spool_max_bytes": v["spool_max_bytes"],
            "spool_location": p["spool"],
            "when_full": "oldest whole segments are deleted first and the count is reported to the "
                         "server, so gaps are visible rather than silent",
        },
        "policy_source": "Every interval and threshold is set by the collector server. These are "
                         "the values in effect now.",
        "device_identity": {"fingerprint_source": ident["source"],
                            "has_smb_uuid": ident["has_smb_uuid"]},
        "local_log": p["log"],
        "uninstall": "scripts/uninstall.ps1 removes the scheduled task and deletes the state "
                     "directory.",
    }
    with open(p["config"], "w", encoding="utf8") as fh:
        fh.write(json.dumps(config, indent=2))
