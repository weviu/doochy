"""Anti-breakout / anti-fade guards — the "July-4 hardening" (shared).

These protect the mean-reversion scanners (scanner.py, metals-scanner.py) from
fading into a move that is actually continuing — squeezes, breakouts, capitulations,
volatility spikes. Named for the July-4 BTC squeeze that exposed the failure mode,
but every guard triggers on market CONDITIONS, not the calendar; they apply to any
structurally similar event.

The tunable constants below are the single source of truth. To change a knob for all
scanners, edit it here. Because each scanner runs as its own process, a driver may
override a specific knob for itself by reassigning it on this module at startup,
e.g. `import core.guards as guards; guards.VOL_SPIKE_VETO_ATR = 3.0` — call sites read
`guards.<NAME>` so the override is picked up live for that process only.

NOTE: xau-scanner.py is a MOMENTUM strategy and deliberately does NOT use these — it
trades WITH breakouts, so fade guards would be counterproductive. Keep it separate.

Not included here (scanner-only, BTC-specific): the #1 BTC volatility circuit breaker
(`should_pause_counter_trend` + `BTC_VOLATILITY_*`) lives in scanner.py.
"""
import numpy as np
from datetime import datetime

from core import config

# All tunable via .env (see core/config.py); defaults below are today's values.
# --- #3 RSI continuation: extreme RSI in the fade direction = momentum, not a top ---
RSI_CONTINUATION_PENALTY_START = config.get_float("RSI_CONTINUATION_PENALTY_START", 75.0)   # begin penalising the fade past here
RSI_CONTINUATION_VETO          = config.get_float("RSI_CONTINUATION_VETO", 82.0)            # drop the fade entirely at/above here
RSI_CONTINUATION_PENALTY_PER_PT = config.get_float("RSI_CONTINUATION_PENALTY_PER_PT", 6.0)  # conf points removed per extremity point over start

# --- #2 Adverse impulse: don't fade a move already running against us (a breakout) ---
FADE_IMPULSE_BARS        = config.get_int("FADE_IMPULSE_BARS", 2)              # bars of "recent" impulse to measure
FADE_IMPULSE_ATR_WINDOW  = config.get_int("FADE_IMPULSE_ATR_WINDOW", 14)       # bars for the ATR baseline
FADE_IMPULSE_PENALTY_ATR = config.get_float("FADE_IMPULSE_PENALTY_ATR", 0.6)   # start penalising once adverse move exceeds this
FADE_IMPULSE_VETO_ATR    = config.get_float("FADE_IMPULSE_VETO_ATR", 1.0)      # veto the fade once adverse move reaches this
FADE_IMPULSE_PENALTY_PER_ATR = config.get_float("FADE_IMPULSE_PENALTY_PER_ATR", 40.0)  # conf points removed per ATR over the penalty start

# --- #4 No re-arm: stop averaging into a same-direction fade at an adverse price ---
NO_REARM_WINDOW_MIN   = config.get_int("NO_REARM_WINDOW_MIN", 120)      # only compare against same-symbol signals this recent
NO_REARM_ADVERSE_PCT  = config.get_float("NO_REARM_ADVERSE_PCT", 0.5)   # skip if new entry is this % worse than the last one

# --- #5 Volatility spike (non-directional): don't fade into a violent bar ---
VOL_SPIKE_PENALTY_ATR     = config.get_float("VOL_SPIKE_PENALTY_ATR", 2.0)      # start penalising the fade once the last bar is this wide
VOL_SPIKE_VETO_ATR        = config.get_float("VOL_SPIKE_VETO_ATR", 3.5)         # veto once the last bar's range reaches this × ATR
VOL_SPIKE_PENALTY_PER_ATR = config.get_float("VOL_SPIKE_PENALTY_PER_ATR", 18.0) # conf points removed per ATR over the penalty start


def _atr_pct(high, low, close, window=FADE_IMPULSE_ATR_WINDOW):
    """Average True Range as a % of price over the last `window` bars. None if short."""
    n = len(close)
    if n < window + 1:
        return None
    trs = []
    for i in range(n - window, n):
        tr = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
        trs.append(tr / close[i-1] * 100 if close[i-1] else 0.0)
    return float(np.mean(trs)) if trs else None


def adverse_impulse_atr(price, high, low, is_sell):
    """How hard price has moved AGAINST a fresh fade over the last FADE_IMPULSE_BARS
    bars, expressed in ATRs. >0 means the market is already running the wrong way for
    this signal (a breakout we'd be fading). Returns 0.0 when it can't be computed."""
    n = len(price)
    if n < FADE_IMPULSE_BARS + 1:
        return 0.0
    atr = _atr_pct(high, low, price)
    if not atr:
        return 0.0
    move_pct = (price[-1] - price[-1 - FADE_IMPULSE_BARS]) / price[-1 - FADE_IMPULSE_BARS] * 100
    adverse = move_pct if is_sell else -move_pct   # up-move hurts a SELL, down-move a BUY
    return adverse / atr


def volatility_spike_atr(high, low, close):
    """#5: the latest bar's high-low range as a multiple of the ATR baseline. A large
    value means a volatility explosion right now (directional or a two-sided wick) — a
    regime where mean-reversion fades are unreliable. Returns 0.0 when uncomputable."""
    atr = _atr_pct(high, low, close)
    if not atr or len(close) < 2 or close[-2] == 0:
        return 0.0
    last_range_pct = (high[-1] - low[-1]) / close[-2] * 100
    return last_range_pct / atr


def rsi_continuation_penalty(rsi_val, is_sell):
    """Return (penalty_conf_points, veto_bool) for fading at this RSI. Extreme RSI in
    the fade direction means momentum/continuation, not a reversal — penalise, then veto."""
    extremity = rsi_val if is_sell else (100 - rsi_val)
    if extremity >= RSI_CONTINUATION_VETO:
        return 0.0, True
    if extremity >= RSI_CONTINUATION_PENALTY_START:
        return (extremity - RSI_CONTINUATION_PENALTY_START) * RSI_CONTINUATION_PENALTY_PER_PT, False
    return 0.0, False


def _is_readvancing_fade(symbol, direction, price, existing, now_dt):
    """#4: True if we'd be re-issuing a same-direction signal into an ADVERSE move —
    i.e. re-shorting higher (or re-buying lower) than a recent alert on this symbol.
    Stops the scanner averaging into a loser (the July-4 'shorted BCH 8× up the rally').
    """
    for e in existing:
        if e.get("symbol") != symbol or e.get("direction") != direction:
            continue
        try:
            ts = datetime.strptime(e["timestamp"], "%Y-%m-%d %H:%M:%S")
            prev_price = float(e["price"])
        except (KeyError, ValueError, TypeError):
            continue
        if (now_dt - ts).total_seconds() > NO_REARM_WINDOW_MIN * 60:
            continue  # too old to count as re-arming
        # adverse = worse entry than last time in the same direction
        if direction == "sell" and price >= prev_price * (1 + NO_REARM_ADVERSE_PCT / 100):
            return True
        if direction == "buy" and price <= prev_price * (1 - NO_REARM_ADVERSE_PCT / 100):
            return True
        return False  # most recent same-symbol/dir alert wasn't adverse → allow
    return False


# ============================================
# WHIPSAW / SESSION-OPEN COOLDOWN (gold)
# ============================================
# Complements #4 (which blocks SAME-direction re-arming). This blocks a DIRECTION FLIP —
# emitting BUY shortly after a SELL (or vice-versa) on the same symbol — which signals chop.
# Stricter around Tokyo/London/NY opens, where flips cluster. Sessions are global market
# events computed in local tz → UTC (DST-correct), NOT server-local.
_SESSION_OPENS = [("Tokyo", "Asia/Tokyo", 9, 0),        # 09:00 JST (no DST)
                  ("London", "Europe/London", 8, 0),    # 08:00 local (BST/GMT handled by tz)
                  ("NewYork", "America/New_York", 8, 0)]  # 08:00 ET (EST/EDT handled by tz)


def _active_gold_session(now_dt, window_min):
    """Name of the session whose open-window `now_dt` falls in ([open, open+window]), else
    None. `now_dt` may be tz-aware or naive-UTC. Degrades to None if zoneinfo is unavailable."""
    try:
        from zoneinfo import ZoneInfo
    except Exception:
        return None
    from datetime import timezone as _tz
    now_utc = now_dt.replace(tzinfo=_tz.utc) if now_dt.tzinfo is None else now_dt.astimezone(_tz.utc)
    for name, tzname, h, m in _SESSION_OPENS:
        try:
            tz = ZoneInfo(tzname)
        except Exception:
            continue
        local = now_utc.astimezone(tz)
        open_utc = local.replace(hour=h, minute=m, second=0, microsecond=0).astimezone(_tz.utc)
        if 0 <= (now_utc - open_utc).total_seconds() <= window_min * 60:
            return name
    return None


def gold_whipsaw_block(direction, existing, now_dt, *, cooldown_min, session_cooldown_min,
                       session_window_min, symbol="XAUUSD", signal_source="gold_scanner"):
    """(blocked, reason). True → suppress this emission: an OPPOSITE-direction signal for
    the same symbol/source was emitted within the cooldown (longer during a session open)."""
    direction = str(direction).lower()
    opp = "sell" if direction == "buy" else "buy"
    session = _active_gold_session(now_dt, session_window_min)
    window = session_cooldown_min if session else cooldown_min
    now_naive = now_dt.replace(tzinfo=None) if now_dt.tzinfo else now_dt
    for e in existing:
        if e.get("symbol") != symbol or e.get("signal_source") != signal_source:
            continue
        if str(e.get("direction", "")).lower() != opp:
            continue
        try:
            ts = datetime.strptime(e["timestamp"], "%Y-%m-%d %H:%M:%S")
        except (KeyError, ValueError, TypeError):
            continue
        age_min = (now_naive - ts).total_seconds() / 60.0
        if 0 <= age_min <= window:
            tag = f"{session}-open " if session else ""
            return True, f"opposite {opp.upper()} {age_min:.0f}m ago (< {window:.0f}m {tag}cooldown)"
    return False, None
