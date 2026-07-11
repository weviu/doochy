"""Central configuration loader for the scanner stack.

Every tunable setting (bot params, indicator params, guard thresholds, signal weights)
resolves through here so it can be changed without editing code. Resolution order,
highest priority first:

    1. Shell environment variable   (e.g. pm2 env, or `FOO=1 python3 scanner.py`)
    2. scanner.config file          (KEY=value lines; the dedicated tuning file — NOT .env,
                                      which is kept for cTrader credentials only)
    3. code default                 (the value passed to get_*())

Per-scanner overrides: each scanner process sets SCANNER_ROLE ("crypto"/"metals"/"xau")
in ecosystem.config.js. A lookup for KEY then tries "<ROLE>_KEY" before the bare "KEY",
so e.g. CRYPTO_VOL_SPIKE_VETO_ATR tunes only the crypto scanner while VOL_SPIKE_VETO_ATR
applies to all three. Run a scanner outside pm2 (no SCANNER_ROLE) and only bare keys apply.

Everything is behavior-preserving: with an empty/absent scanner.config, every get_*()
returns the code default, which is today's hard-coded value — nothing changes until tuned.
The config path can be overridden with the SCANNER_CONFIG env var (e.g. for tests).
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
# Dedicated settings file at the repo root (separate from .env, which holds only creds).
_CONFIG_PATH = os.environ.get("SCANNER_CONFIG") or os.path.join(os.path.dirname(_HERE), "scanner.config")


def _load_config_file(path):
    settings = {}
    if not os.path.exists(path):
        return settings
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if " #" in v:                     # strip trailing inline comment ("3.5  # note")
            v = v.split(" #", 1)[0].strip()
        settings[k.strip()] = v
    return settings


_FILE_CFG = _load_config_file(_CONFIG_PATH)
ROLE = (os.environ.get("SCANNER_ROLE") or "").strip().upper()


def _raw(key):
    """Resolve the raw string for `key`, honouring role prefix then precedence."""
    keys = ([f"{ROLE}_{key}"] if ROLE else []) + [key]
    for k in keys:
        if k in os.environ:      # 1. shell env
            return os.environ[k]
        if k in _FILE_CFG:       # 2. scanner.config file
            return _FILE_CFG[k]
    return None                  # 3. -> caller's default


def get_str(key, default):
    v = _raw(key)
    return default if v is None else v


def get_float(key, default):
    v = _raw(key)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def get_int(key, default):
    v = _raw(key)
    if v is None:
        return default
    try:
        return int(float(v))
    except ValueError:
        return default


def get_bool(key, default):
    v = _raw(key)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def get_list(key, default, sep=","):
    v = _raw(key)
    if v is None:
        return default
    return [x.strip() for x in v.split(sep) if x.strip()]
