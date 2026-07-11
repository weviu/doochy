"""Scanner health heartbeat — outage watchdog shared by all scanners.

Motivation (2026-07-09): gold-scanner spent 9.3h failing every scan with
RET_ACCOUNT_DISABLED (cTrader auth) and nobody noticed — one ❌ line per scan
in a pm2 log nobody was watching. This module gives every scanner a dirt-cheap
heartbeat: call `report_ok(name)` after a successful scan and
`report_error(name, err)` on failure, and it

  - maintains `data/scanner_health.json` (atomic writes; served by feed-server
    on :8880 alongside alerts.json, so doochybot / external monitoring can poll
    it: any scanner with status != "ok" or a stale `last_success` is in trouble);
  - tracks consecutive failures and prints an UNMISSABLE banner once they reach
    `HEALTH_ALARM_AFTER` (auth-class errors get a "will NOT self-heal" banner —
    credential failures never fix themselves, unlike transient routing blips).
"""
import json
import os
from datetime import datetime, timezone

from core import config

HEALTH_PATH = config.get_str("HEALTH_PATH", "./data/scanner_health.json")
ALARM_AFTER = config.get_int("HEALTH_ALARM_AFTER", 3)  # consecutive failures before the banner

# Substrings (upper-cased match) that mark an error as an auth/credential failure —
# these never self-heal, so the alarm says so explicitly.
_AUTH_MARKERS = ("RET_ACCOUNT_DISABLED", "AUTH", "ACCESS_TOKEN", "INVALID_REQUEST", "CH_ACCESS")


def _now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _load():
    try:
        with open(HEALTH_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _write(state):
    try:
        os.makedirs(os.path.dirname(HEALTH_PATH), exist_ok=True)
        tmp = HEALTH_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, HEALTH_PATH)
    except (PermissionError, OSError) as e:
        print(f"⚠️ health file unwritable: {e}")


def report_ok(scanner):
    """Record a successful scan (a clean 'no setups' counts — the feed worked)."""
    state = _load()
    entry = state.get(scanner, {})
    if entry.get("consecutive_failures"):
        print(f"💚 {scanner} recovered after {entry['consecutive_failures']} failed scans.")
    state[scanner] = {
        "status": "ok",
        "last_success": _now_utc(),
        "last_error_at": entry.get("last_error_at"),
        "last_error": entry.get("last_error"),
        "consecutive_failures": 0,
    }
    _write(state)


def report_error(scanner, err):
    """Record a failed scan; alarm loudly once failures streak past ALARM_AFTER."""
    msg = str(err)[:200]
    is_auth = any(m in msg.upper() for m in _AUTH_MARKERS)
    state = _load()
    entry = state.get(scanner, {})
    n = entry.get("consecutive_failures", 0) + 1
    state[scanner] = {
        "status": "auth_failed" if is_auth else "error",
        "last_success": entry.get("last_success"),
        "last_error_at": _now_utc(),
        "last_error": msg,
        "consecutive_failures": n,
    }
    _write(state)

    if n >= ALARM_AFTER:
        since = entry.get("last_success") or "unknown"
        print("\n" + "🚨" * 25)
        print(f"🚨 {scanner}: {n} CONSECUTIVE FAILED SCANS — feed is DOWN (last success: {since} UTC)")
        print(f"🚨 last error: {msg}")
        if is_auth:
            print("🚨 AUTH-CLASS FAILURE — this will NOT self-heal. Fix credentials in .env "
                  "and restart the scanner.")
        print("🚨" * 25 + "\n")
    return n
