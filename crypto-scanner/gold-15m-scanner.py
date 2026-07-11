#!/usr/bin/env python3
"""
Gold (XAUUSD) SHORT-TERM 15m scanner — cTrader feed → data/alerts.json.

A deliberately higher-frequency, lower-conviction companion to gold-scanner.py.
Where gold-scanner's edges are 1h-sourced (~2/week, strong), this one trades the
15m chart for a few signals a day. It is an INDEPENDENT stream (its own
signal_source); doochybot nets exposure across scanners.

Only strategies that cleared positive expectancy NET OF COSTS on a 7-month 15m
XAUUSD walk-forward (2026-07-09, SL-first same-bar, $0.35/oz round trip) ship
here. 15m mean-reversion was retested and REJECTED again (VWAP-fade fragile,
wick-rejection flat, RSI2 negative) — the surviving edges are all momentum /
structure, gated by the higher-timeframe cloud:

  A  MOMENTUM BREAKOUT (donchian)  — the primary edge. First 15m close beyond the
     prior-N-bar high/low, taken ONLY with both the 4h AND 1h EMA34/134 clouds on
     the breakout side. ATR stop (1.5×) / target (2.0×). Backtest: +0.158 avgR,
     n=300, 51% win, and — unlike the 1h scanner's regime-fragile shorts —
     SYMMETRIC (BUY +0.18 / SELL +0.14) and positive in both sample halves,
     because it follows the LIVE cloud rather than betting on the bull. The
     donchian lookback sits on a broad positive plateau (lb40..lb80 all +0.15..0.20),
     so it is not a fitted point.

  D  VWAP RECLAIM (SELL-only)  — the volume play. Price crossing back through the
     session-anchored VWAP (reset 00:00 UTC) in the direction of the 4h cloud.
     The backtested edge is entirely short-side (SELL +0.141 vs BUY +0.005 flat),
     so only SELLs are emitted: a 4h-red-cloud loss of VWAP. Higher frequency
     (~1.5 SELL/day), lower conviction. ATR stop (1.5×) / target (2.0×).

  [B  DOUBLE-HTF CLOUD PULLBACK — measured +0.169 avgR but deferred by request;
      see _s_b_pullback stub. Re-enable when revisited.]

  CONFLUENCE + GATES  (shared with the siblings via core/*)
      • 4h EMA34/134 cloud: +conf aligned. (Strategies are already hard-gated to
        the cloud at generation, so opposed signals never reach the combiner.)
      • ≥2 strategies agreeing → confluence bonus; opposing → both dropped.
      • Session gate: dead hours (21-22 UTC) no entries; quiet Asia −conf;
        Tokyo/London/NY-open windows require the 65 session floor.
      • Whipsaw guard + feed-level no-re-arm guard (core/guards).
      • src_bar feed dedupe (the 15m closed bar) — the --loop 5 cadence re-detects
        the same bar 3× before it rolls; core/feed dedupes on src_bar.

Usage:
    python gold-15m-scanner.py                 # 15m
    python gold-15m-scanner.py -v --loop 5
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import ctrader_feed
from core import config, guards, health
from core.feed import write_to_feed as _core_write_to_feed
from core.strategy import calculate_position_size
from core.trend import ema, atr as _atr, wilder_rsi as rsi, cloud_direction
from core import trend as _trend

# ============================================
# CONFIG (.env-tunable; X15_* prefix)
# ============================================
CTRADER_SYMBOL = "XAUUSD"
FEED_SYMBOL = "XAUUSD"
SIGNAL_SOURCE = "gold_15m_scanner"
FEED_PATH = "./data/alerts.json"

LOOKBACK = config.get_int("X15_LOOKBACK", 600)   # 15m bars: EMA134 warmup + donchian + a session of VWAP
ATR_WINDOW = config.get_int("X15_ATR_WINDOW", 14)

# --- Cloud definition (shared by the HTF gates) ---
CLOUD_FAST = config.get_int("X15_CLOUD_FAST", 34)
CLOUD_SLOW = config.get_int("X15_CLOUD_SLOW", 134)

# --- A: momentum breakout (donchian) ---
DONCHIAN_LB = config.get_int("X15_DONCHIAN_LB", 40)       # prior-N extreme; positive plateau lb40..80
MOM_STOP_ATR = config.get_float("X15_MOM_STOP_ATR", 1.5)
MOM_TP_ATR = config.get_float("X15_MOM_TP_ATR", 2.0)
CONF_MOM = config.get_float("X15_CONF_MOM", 62.0)

# --- D: VWAP reclaim (SELL-only) ---
VWAP_STOP_ATR = config.get_float("X15_VWAP_STOP_ATR", 1.5)
VWAP_TP_ATR = config.get_float("X15_VWAP_TP_ATR", 2.0)
CONF_VWAP = config.get_float("X15_CONF_VWAP", 55.0)
VWAP_SELL_ONLY = config.get_bool("X15_VWAP_SELL_ONLY", True)   # BUY side backtested flat (+0.005)

# --- Confluence / HTF gates ---
HTF1_TIMEFRAME = config.get_str("X15_HTF1_TIMEFRAME", "1h")
HTF4_TIMEFRAME = config.get_str("X15_HTF4_TIMEFRAME", "4h")
HTF_ALIGN_BONUS = config.get_float("X15_HTF_ALIGN_BONUS", 8.0)
HTF_OPPOSE_PENALTY = config.get_float("X15_HTF_OPPOSE_PENALTY", 12.0)
CONFLUENCE_BONUS = config.get_float("X15_CONFLUENCE_BONUS", 10.0)
MIN_CONF = config.get_float("X15_MIN_CONF", 50.0)             # lower than the 1h scanners' 55 by design
MAX_CONF = 95.0

# Session gate (same market structure as gold-scanner).
DEAD_HOURS_UTC = set(config.get_list("X15_DEAD_HOURS_UTC", ["21", "22"]))
QUIET_HOURS_UTC = set(config.get_list("X15_QUIET_HOURS_UTC", ["23", "0", "1", "2", "3", "4", "5"]))
QUIET_PENALTY = config.get_float("X15_QUIET_PENALTY", 10.0)

WHIPSAW_GUARD = config.get_bool("X15_WHIPSAW_GUARD", True)
CONTRA_COOLDOWN_MIN = config.get_int("X15_CONTRA_COOLDOWN_MIN", 30)
SESSION_COOLDOWN_MIN = config.get_int("X15_SESSION_COOLDOWN_MIN", 45)
SESSION_WINDOW_MIN = config.get_int("X15_SESSION_WINDOW_MIN", 30)
SESSION_MIN_CONF = config.get_float("X15_SESSION_MIN_CONF", 65.0)


# ============================================
# HELPERS
# ============================================

def atr(high, low, close, period=ATR_WINDOW):
    return _atr(high, low, close, period)


def _closed_bars(timeframe, count):
    """Fetch trendbars and drop the still-forming last bar (signals read closed
    candles only). None on fetch failure / short series."""
    df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=count)
    if df is None or len(df) < 5:
        return None
    interval_s = ctrader_feed.TIMEFRAMES.get(timeframe, (0, 60))[1] * 60
    if int(df["timestamp"].iloc[-1]) // 1000 + interval_s > time.time():
        df = df.iloc[:-1]
    return df


def _src_bar(df):
    """Feed dedupe tag: UTC timestamp of the last CLOSED bar the signal was read
    from. The --loop 5 cadence re-detects the same 15m bar until it rolls; the
    same src_bar ⇒ the same signal (see core/feed)."""
    return datetime.fromtimestamp(int(df["timestamp"].iloc[-1]) // 1000,
                                  tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _htf_cloud(timeframe):
    """'BUY'/'SELL' EMA34/134 cloud direction on a higher timeframe. None if
    unavailable — a missing gate fails CLOSED (no signal), never open."""
    try:
        df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=CLOUD_SLOW + 60)
        if df is None or len(df) < CLOUD_SLOW + 5:
            return None
        return cloud_direction(df["close"].values, CLOUD_FAST, CLOUD_SLOW)
    except Exception as e:
        print(f"⚠️ {timeframe} cloud unavailable: {str(e)[:60]}")
        return None


# ============================================
# STRATEGIES  (each reads the last CLOSED 15m bar; stop/TP re-anchored to live price)
# ============================================

def s_a_momentum(df, price, htf1, htf4):
    """A: donchian-N breakout, hard-gated to BOTH the 1h and 4h clouds.

    Fires on the FIRST close beyond the prior-N extreme (the previous bar was
    still inside), so a persistent breakout doesn't re-arm every bar. Both HTF
    clouds must be on the breakout side — this is exactly the backtested subset."""
    if htf1 is None or htf4 is None:
        return None
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    if len(c) < DONCHIAN_LB + 5:
        return None
    atr_now = atr(h, l, c)[-1]
    if not atr_now or np.isnan(atr_now):
        return None
    prior_hi = h[-1 - DONCHIAN_LB:-1].max()
    prior_lo = l[-1 - DONCHIAN_LB:-1].min()
    prev_prior_hi = h[-2 - DONCHIAN_LB:-2].max()
    prev_prior_lo = l[-2 - DONCHIAN_LB:-2].min()

    direction = None
    if c[-1] > prior_hi and c[-2] <= prev_prior_hi:
        direction, level = "BUY", prior_hi
    elif c[-1] < prior_lo and c[-2] >= prev_prior_lo:
        direction, level = "SELL", prior_lo
    if direction is None:
        return None
    if htf1 != direction or htf4 != direction:      # hard double-HTF gate
        return None

    if direction == "BUY":
        stop, tp = price - MOM_STOP_ATR * atr_now, price + MOM_TP_ATR * atr_now
    else:
        stop, tp = price + MOM_STOP_ATR * atr_now, price - MOM_TP_ATR * atr_now
    return {"strategy": "momentum_breakout", "direction": direction, "conf": CONF_MOM,
            "stop": stop, "tp": tp, "src_bar": _src_bar(df),
            "note": f"{DONCHIAN_LB}-bar breakout {'above' if direction=='BUY' else 'below'} "
                    f"{level:.2f}, 4h+1h cloud aligned"}


def _session_vwap(df):
    """Session-anchored VWAP (reset 00:00 UTC), typical price × tick volume.
    Returns an array aligned to df rows."""
    ts = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    typ = (df["high"].values + df["low"].values + df["close"].values) / 3.0
    vol = df["volume"].values
    day = ts.dt.date.values
    out = np.full(len(df), np.nan)
    cum_pv = cum_v = 0.0
    cur = None
    for i in range(len(df)):
        if day[i] != cur:
            cur = day[i]; cum_pv = cum_v = 0.0
        cum_pv += typ[i] * vol[i]; cum_v += vol[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


def s_d_vwap_reclaim(df, price, htf4):
    """D: close crossing back through the session VWAP in the 4h-cloud direction.
    SELL-only by default (the backtested BUY side is flat) — a 4h-red loss of VWAP."""
    if htf4 is None:
        return None
    c = df["close"].values
    if len(c) < CLOUD_SLOW + 5:
        return None
    vwap = _session_vwap(df)
    if np.isnan(vwap[-1]) or np.isnan(vwap[-2]):
        return None
    atr_now = atr(df["high"].values, df["low"].values, c)[-1]
    if not atr_now or np.isnan(atr_now):
        return None

    direction = None
    if c[-1] < vwap[-1] and c[-2] >= vwap[-2]:
        direction = "SELL"
    elif c[-1] > vwap[-1] and c[-2] <= vwap[-2]:
        direction = "BUY"
    if direction is None:
        return None
    if VWAP_SELL_ONLY and direction != "SELL":
        return None
    if htf4 != direction:                            # hard 4h gate
        return None

    if direction == "SELL":
        stop, tp = price + VWAP_STOP_ATR * atr_now, price - VWAP_TP_ATR * atr_now
    else:
        stop, tp = price - VWAP_STOP_ATR * atr_now, price + VWAP_TP_ATR * atr_now
    return {"strategy": "vwap_reclaim", "direction": direction, "conf": CONF_VWAP,
            "stop": stop, "tp": tp, "src_bar": _src_bar(df),
            "note": f"lost session VWAP {vwap[-1]:.2f}, 4h cloud {direction.lower()}-aligned"}


# [B slot] def s_b_pullback(df, price, htf1, htf4): double-HTF EMA5/8 cloud
#   resume-cross (core.trend.cloud_pullback), +0.169 avgR backtested. Deferred.


# ============================================
# SCAN
# ============================================

def _load_feed(feed_path):
    try:
        with open(feed_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def scan(timeframe, verbose, account_size, risk_percent,
         use_momentum=True, use_vwap=True, use_session=True, feed_path=FEED_PATH):
    now = datetime.now(timezone.utc)
    print(f"\n{'='*100}")
    print(f"🥇⚡ GOLD 15m SCANNER (cTrader {CTRADER_SYMBOL}): {timeframe} | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"   Strategies: momentum={'✅' if use_momentum else '❌'} "
          f"vwap_reclaim={'✅' if use_vwap else '❌'} | session gate={'✅' if use_session else '❌'}")
    print(f"{'='*100}")

    if use_session and str(now.hour) in DEAD_HOURS_UTC:
        print(f"🌙 Dead hour ({now.hour}:00 UTC — COMEX settle/close). No entries taken.")
        return

    df = _closed_bars(timeframe, LOOKBACK)
    if df is None or len(df) < CLOUD_SLOW + DONCHIAN_LB + 5:
        print(f"❌ insufficient data ({0 if df is None else len(df)} bars)")
        return

    close = df["close"].values
    price = float(close[-1])
    atr_now = atr(df["high"].values, df["low"].values, close)[-1]
    rsi14 = float(rsi(close, 14)[-1])

    htf1 = _htf_cloud(HTF1_TIMEFRAME)
    htf4 = _htf_cloud(HTF4_TIMEFRAME)

    candidates = []
    if use_momentum:
        candidates.append(s_a_momentum(df, price, htf1, htf4))
    if use_vwap:
        candidates.append(s_d_vwap_reclaim(df, price, htf4))
    candidates = [c for c in candidates if c]

    if verbose:
        e34, e134 = ema(close, CLOUD_FAST)[-1], ema(close, CLOUD_SLOW)[-1]
        print(f"   price={price:.2f}  ATR({ATR_WINDOW})={atr_now:.2f}  RSI14={rsi14:.1f}  "
              f"15m-cloud={'green' if e34 > e134 else 'red'}  "
              f"1h={htf1 or 'n/a'}  4h={htf4 or 'n/a'}")

    if not candidates:
        print("📭 No setups on this scan.")
        return

    best, conf = _trend.combine(
        candidates, htf4,
        confluence_bonus=CONFLUENCE_BONUS, htf_align_bonus=HTF_ALIGN_BONUS,
        htf_oppose_penalty=HTF_OPPOSE_PENALTY, max_conf=MAX_CONF,
    )
    if best == "conflict":
        print("⚖️  Conflicting directions across strategies — standing aside:")
        for c in candidates:
            print(f"   {c['direction']:<4} {c['strategy']}: {c['note']}")
        return

    if use_session and str(now.hour) in QUIET_HOURS_UTC:
        conf = min(conf - QUIET_PENALTY, MAX_CONF)

    if WHIPSAW_GUARD:
        blocked, why = guards.gold_whipsaw_block(
            best["direction"], _load_feed(feed_path), now,
            cooldown_min=CONTRA_COOLDOWN_MIN, session_cooldown_min=SESSION_COOLDOWN_MIN,
            session_window_min=SESSION_WINDOW_MIN,
            symbol=FEED_SYMBOL, signal_source=SIGNAL_SOURCE)
        if blocked:
            print(f"🔁 Whipsaw guard — standing aside: {why}")
            return
        sess = guards._active_gold_session(now, SESSION_WINDOW_MIN)
        if sess and conf < SESSION_MIN_CONF:
            print(f"🕘 {sess}-open window — conf {conf:.0f} < session floor {SESSION_MIN_CONF:.0f}. Standing aside.")
            return

    print(f"\n🎯 {best['direction']} {FEED_SYMBOL} @ ${price:.2f}  (confidence {conf:.0f}%)")
    print(f"   strategy: {best['strategy']}"
          + (f"  +confluence: {', '.join(c['strategy'] for c in candidates if c is not best)}"
             if len(candidates) > 1 else ""))
    print(f"   {best['note']}")
    print(f"   HTF(4h) trend: {htf4 or 'n/a'} ({'aligned ✅' if htf4 == best['direction'] else '—'})")
    risk = abs(price - best["stop"])
    reward = abs(best["tp"] - price)
    print(f"   🛑 SL ${best['stop']:.2f}  🎯 TP ${best['tp']:.2f}  "
          f"(risk ${risk:.2f} / reward ${reward:.2f} → R:R {reward/risk:.2f})" if risk else "")
    pos = calculate_position_size(price, best["stop"], conf, account_size, risk_percent)
    print(f"   📊 size {pos['size']:.4f} oz (${pos['value']:.2f}) | risk ${pos['risk_amount']:.2f} "
          f"({pos['risk_percent']:.2f}% of account)")

    if conf < MIN_CONF:
        print(f"\n🚫 Confidence {conf:.0f}% < minimum {MIN_CONF:.0f}% — not written to feed.")
        return

    signal = {
        "symbol": FEED_SYMBOL,
        "signal_type": best["direction"],
        "confidence": conf,
        "rsi": round(rsi14, 2),
        "price": price,
        "stop_loss": round(best["stop"], 2),
        "tp1": round(best["tp"], 2),
        "time_exit_min": None,
        "src_bar": best.get("src_bar"),
    }
    _core_write_to_feed(
        [signal], timeframe,
        signal_source=SIGNAL_SOURCE,
        btc_state=None,
        feed_path=feed_path,
        futures_symbols=(FEED_SYMBOL,),
        readvancing_fade=guards._is_readvancing_fade,
    )


# ============================================
# CLI / RUN
# ============================================

def parse_args():
    p = argparse.ArgumentParser(description="Gold (XAUUSD) short-term 15m scanner")
    p.add_argument("-tf", "--timeframe", default=config.get_str("X15_TIMEFRAME", "15m"),
                   help="intraday TF (default 15m; X15_TIMEFRAME)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--account-size", type=float, default=config.get_float("ACCOUNT_SIZE", 10000))
    p.add_argument("--risk", type=float, default=config.get_float("RISK", 0.01))
    p.add_argument("--min-conf", type=float, default=None, help=f"override X15_MIN_CONF ({MIN_CONF})")
    p.add_argument("--no-momentum", action="store_true", help="disable donchian breakout (A)")
    p.add_argument("--no-vwap", action="store_true", help="disable VWAP reclaim (D)")
    p.add_argument("--no-session-filter", action="store_true", help="ignore dead/quiet hour gates")
    p.add_argument("--loop", type=int, default=config.get_int("X15_LOOP", 0),
                   help="rescan every N minutes, clock-aligned (0 = single run)")
    return p.parse_args()


def main():
    global MIN_CONF
    args = parse_args()
    valid = set(ctrader_feed.TIMEFRAMES) | set(ctrader_feed.DERIVED_TIMEFRAMES)
    if args.timeframe not in valid:
        print(f"❌ Invalid timeframe {args.timeframe}. Options: {', '.join(sorted(valid))}")
        sys.exit(1)
    if args.min_conf is not None:
        MIN_CONF = args.min_conf

    def _run_once():
        t0 = time.time()
        try:
            scan(args.timeframe, args.verbose, args.account_size, args.risk,
                 use_momentum=not args.no_momentum,
                 use_vwap=not args.no_vwap,
                 use_session=not args.no_session_filter)
            health.report_ok("gold-15m-scanner")
        except Exception as e:
            print(f"❌ scan failed: {str(e)[:100]}")
            health.report_error("gold-15m-scanner", e)
        print(f"⏱️ Scan completed in {time.time() - t0:.2f}s")

    if args.loop > 0:
        interval = args.loop * 60
        print(f"🔁 Loop mode: every {args.loop} min, clock-aligned. Ctrl-C to stop.")
        while True:
            try:
                _run_once()
                sleep_for = interval - (time.time() % interval)
                print(f"😴 Next scan in {sleep_for/60:.1f} min...\n")
                time.sleep(sleep_for)
            except KeyboardInterrupt:
                print("\n👋 Scanner stopped.")
                break
    else:
        _run_once()


if __name__ == "__main__":
    main()
