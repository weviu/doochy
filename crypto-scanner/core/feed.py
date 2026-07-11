"""The signal feed contract — shared by all scanners.

`data/alerts.json` is the interface doochybot consumes, so its schema and write
semantics live in exactly one place. Every scanner builds its signals however it
likes, then hands them here to be normalised, guarded, and written atomically.

Driver-specific behaviour is passed in rather than forked:
  - `signal_source`     — the tag written to each entry ("signal_scanner", etc.)
  - `btc_state`         — composite BTC regime string (crypto only; None otherwise)
  - `futures_symbols`   — raw symbols that must carry btc_state=None (non-crypto)
  - `readvancing_fade`  — optional guard callback (symbol, direction, price,
                          existing, now_dt) -> bool; when it returns True the
                          signal is dropped as a re-arming fade into an adverse move.
"""
import os
import json
from datetime import datetime, timedelta

from core import config

FEED_CAP = 500  # newest-first, capped

# Dedupe window: a scanner looping faster than its source timeframe re-detects the
# SAME bar's signal until the bar rolls, writing it repeatedly — a 1h-sourced signal
# re-anchored to live spot even re-fires with a *different* price each 15m bar (the
# gold S3 duplicates of 2026-07-08). Signals carrying `src_bar` (the closed source-bar
# timestamp) dedupe on it directly; legacy signals fall back to exact-price match.
# Window must exceed the slowest source bar (1h) — 75 min. 0 disables.
DEDUP_WINDOW_MIN = config.get_int("FEED_DEDUP_WINDOW_MIN", 75)

# `timestamp` stays UTC (the contract field doochybot/backtest/guards rely on). A parallel
# `timestamp_local` is written purely for human debugging, offset by this many hours.
LOCAL_UTC_OFFSET_HOURS = 3


def normalize_symbol(raw_symbol):
    """Normalise an exchange symbol to the feed's <BASE>USD form.

    Handles slash pairs (BCH/USDT -> BCHUSD), futures (XAU/USDT:USDT -> XAUUSD),
    concatenated pairs (BCHUSDT -> BCHUSD), and is idempotent for already-converted
    symbols (XAUUSD -> XAUUSD).
    """
    if ":" in raw_symbol:
        raw_symbol = raw_symbol.split(":")[0]   # drop futures settlement suffix
    if "/" in raw_symbol:
        return raw_symbol.split("/")[0] + "USD"  # slash pair -> base + USD
    elif raw_symbol.endswith("USDT"):
        return raw_symbol[:-4] + "USD"           # concatenated USDT pair -> base + USD
    return raw_symbol                            # already USD (or other) -> unchanged


def _is_duplicate(symbol, signal_source, direction, price, src_bar, existing, now_dt):
    """True if this alert re-states one already in the feed (same symbol+source+
    direction) younger than DEDUP_WINDOW_MIN. Sameness = equal `src_bar` (closed
    source-bar timestamp) when both carry one, else equal price (identical price ⇒
    same source bar; a genuinely new signal on a later bar carries a new close)."""
    for prev in existing:                      # newest-first
        if (prev.get("symbol") != symbol or prev.get("signal_source") != signal_source
                or prev.get("direction") != direction):
            continue
        try:
            ts = datetime.strptime(prev["timestamp"], "%Y-%m-%d %H:%M:%S")
        except (KeyError, ValueError):
            continue
        if (now_dt - ts).total_seconds() > DEDUP_WINDOW_MIN * 60:
            return False                       # newest matching entry too old — not a dupe
        if src_bar and prev.get("src_bar"):
            return prev["src_bar"] == src_bar
        return prev.get("price") == price
    return False


def write_to_feed(signals, timeframe, signal_source, btc_state=None,
                  feed_path="./data/alerts.json", futures_symbols=(),
                  readvancing_fade=None):
    if not signals:
        return

    # Load the current feed up front so the no-re-arm guard can see recent alerts.
    existing = []
    if os.path.exists(feed_path):
        with open(feed_path, "r") as f:
            try:
                existing = json.load(f)
            except json.JSONDecodeError:
                existing = []
    now_dt = datetime.utcnow()

    feed_entries = []
    for sig in signals:
        conf = round(sig["confidence"], 1)
        direction = "buy" if "BUY" in sig["signal_type"] else "sell"
        symbol = normalize_symbol(sig["symbol"])

        # #4: skip if this just re-arms a same-direction fade into an adverse move.
        if readvancing_fade is not None and \
                readvancing_fade(symbol, direction, sig["price"], existing, now_dt):
            print(f"↩️  {symbol} {direction} skipped — re-arming into adverse move")
            continue

        # Dedupe: same signal re-detected from the same source bar on a later scan
        # loop — don't write it again within the window.
        if DEDUP_WINDOW_MIN > 0 and _is_duplicate(
                symbol, signal_source, direction, sig["price"], sig.get("src_bar"),
                existing, now_dt):
            print(f"🔁 {symbol} {direction} deduped — same signal already in feed "
                  f"(< {DEDUP_WINDOW_MIN}m old)")
            continue

        # Only crypto tracks BTC's macro state; metals (XAU/XAG futures) carry null.
        is_crypto = sig["symbol"] not in futures_symbols

        gen_utc = datetime.utcnow()
        entry = {
            "timestamp": gen_utc.strftime("%Y-%m-%d %H:%M:%S"),                                     # UTC (contract)
            "timestamp_local": (gen_utc + timedelta(hours=LOCAL_UTC_OFFSET_HOURS)).strftime("%Y-%m-%d %H:%M:%S"),  # UTC+offset, debug only
            "symbol": symbol,
            "timeframe": timeframe,
            "direction": direction,
            "rsi": sig["rsi"],
            "price": sig["price"],           # market-at-spot: entry snapped to spot (no resting orders)
            "current_price": sig["price"],   # spot at generation (equals price under market-at-spot)
            "pivot_level": None,
            "pivot_distance": None,
            "confidence": conf,
            "sl": sig["stop_loss"],
            "tp": sig["tp1"],
            # Optional time-based exit: doochybot closes the position at market this many
            # minutes after fill (SL stays armed). None for sources that don't use it, so
            # every existing scanner is unaffected.
            "time_exit_min": sig.get("time_exit_min"),
            # Closed source-bar UTC ts the signal was read from (dedupe key). None for
            # scanners that don't tag it — additive, consumers may ignore it.
            "src_bar": sig.get("src_bar"),
            "btc_state": btc_state if is_crypto else None,
            "signal_source": signal_source,
        }
        feed_entries.append(entry)

    if not feed_entries:
        return

    try:
        os.makedirs(os.path.dirname(feed_path), exist_ok=True)
    except (PermissionError, OSError):
        feed_path = "./alerts.json"

    combined = (feed_entries + existing)[:FEED_CAP]
    tmp_path = feed_path + ".tmp"
    try:
        with open(tmp_path, "w") as f:
            json.dump(combined, f, indent=2)
        os.replace(tmp_path, feed_path)
        print(f"✅ Wrote {len(feed_entries)} signals to {feed_path}")
    except (PermissionError, OSError) as e:
        print(f"⚠️ Could not write to feed: {e}")
