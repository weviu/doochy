#!/usr/bin/env python3
"""
Silver (XAGUSD) signal scanner — cTrader feed → data/alerts.json (market entries).

Silver is NOT gold at 2× leverage — it was measured before this file was designed
(cTrader XAGUSD, 1h≈10mo / 15m≈8wk, 2026-07-08):

  • 2.3× gold's volatility (1h ATR ≈ 0.94% of price vs 0.43%) with far fatter
    tails (1h return kurtosis 29 vs 20) — flash spikes and stop-runs are routine.
  • Wicks are ~55% of the median bar's range; in ABSOLUTE terms silver's
    rejection wicks are enormous, which is the visual "all wicks" character.
  • NO exploitable lead-lag vs gold (lagged 1h corr ≈ 0.0; same-bar 0.80), so
    there is no "silver catches up to gold" trade — silver must be read alone.

Two strategies survived a walk-forward, cost-adjusted backtest on that data
(SL-first on same-bar touch; several rejected alternatives listed at the end):

  S1  WICK-REJECTION SWEEP FADE (with-trend)  — silver-native
      A bar sweeps the prior 24-bar extreme AGAINST the EMA34/134 cloud trend,
      prints a long rejection wick (≥ 0.6×ATR and ≥ 55% of the bar's range),
      and CLOSES back beyond the swept level: a failed stop-hunt. Enter in the
      trend direction on the reclaim. SL 1.5×ATR / TP 2.0×ATR.
      Unfiltered this is flat (fading with-sweep in a downtrend gets run
      over); the cloud filter is what makes it: 1h +0.36 avgR (n=30, 60% win),
      15m +0.20 avgR (n=20). Small samples — sized honestly via base conf.

  S2  CONNORS RSI(2) PULLBACK + TIME-EXIT  — 1h source, any scan TF
      Same recipe the gold backtests settled on, revalidated on silver where
      it is broader: positive across the ENTIRE tested exit grid on both 1h
      and 15m. Trigger/SMA200 on the last CLOSED 1h bar; the edge is the
      TIME-based exit (8×1h bars ≈ +0.14 avgR at SL1.5), so the near TP is
      replaced by a far backstop and `time_exit_min` is handed to doochybot.

  CONFLUENCE + GATES  (soft, not hard — S2 is a fade; hard HTF gates strip it)
      • 4h EMA34/134 cloud: +conf aligned / −conf opposed (via core/trend.combine).
      • Both strategies agreeing → confluence bonus; disagreeing → stand aside.
      • Session gate: dead hours 21–22 UTC (COMEX settle) blocked; quiet Asian
        hours −conf. Silver's thin-market spread blowouts are worse than gold's.
      • Whipsaw/session-open guard + feed-level no-re-arm guard (core/guards).

REJECTED in the same backtest (do not re-add without new evidence):
  – prior-day high/low sweep-reclaim: negative at every exit on both TFs;
  – range-compression (squeeze) breakout: sign flips between 1h and 15m;
  – gold→silver lag/catch-up: no lagged correlation to trade;
  – unfiltered (counter-trend) wick fades: flat to negative.

Usage:
    python silver-scanner.py               # default 15m
    python silver-scanner.py -tf 1h -v
    python silver-scanner.py --loop 15     # rescan every 15 min
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
# CONFIG (.env-tunable; see core/config.py)
# ============================================
CTRADER_SYMBOL = "XAGUSD"
FEED_SYMBOL = "XAGUSD"
SIGNAL_SOURCE = "silver_scanner"
FEED_PATH = "./data/alerts.json"
PX_DECIMALS = 3  # silver quotes in 3 decimals (~$37.xxx)

LOOKBACK = config.get_int("SILVER_LOOKBACK", 400)  # bars: EMA134 warmup + sweep lookback

# --- S1: wick-rejection sweep fade (with-trend) ---
# Tuned values are the config that was positive on BOTH 1h and 15m (neighbouring
# configs that shone on one TF and died on the other were rejected as overfit).
SWEEP_LOOKBACK = config.get_int("SILVER_SWEEP_LOOKBACK", 24)     # bars defining the swept extreme
WICK_MIN_ATR = config.get_float("SILVER_WICK_MIN_ATR", 0.6)      # rejection wick ≥ this × ATR
WICK_MIN_FRAC = config.get_float("SILVER_WICK_MIN_FRAC", 0.55)   # ...and ≥ this fraction of bar range
WICK_STOP_ATR = config.get_float("SILVER_WICK_STOP_ATR", 1.5)
WICK_TP_ATR = config.get_float("SILVER_WICK_TP_ATR", 2.0)
CONF_WICK = config.get_float("SILVER_CONF_WICK", 62.0)

# --- S2: Connors RSI(2), 1h source + time exit ---
RSI2_TIMEFRAME = config.get_str("SILVER_RSI2_TIMEFRAME", "1h")
RSI2_LOOKBACK = config.get_int("SILVER_RSI2_LOOKBACK", 300)      # SMA200 + warmup
RSI2_BUY_LVL = config.get_float("SILVER_RSI2_BUY", 10.0)
RSI2_SELL_LVL = config.get_float("SILVER_RSI2_SELL", 90.0)
RSI2_MA = config.get_int("SILVER_RSI2_MA", 200)
RSI2_STOP_ATR = config.get_float("SILVER_RSI2_STOP_ATR", 1.5)
RSI2_TP_ATR = config.get_float("SILVER_RSI2_TP_ATR", 2.0)        # used only if time-exit disabled
CONF_RSI2 = config.get_float("SILVER_CONF_RSI2", 58.0)
# Time exit is the validated S2 edge (positive across the whole 6–24-bar grid on
# silver). 8 bars ≈ gold's prop-account choice: most of the edge, least tail-time
# in a fat-tailed market. 0 disables → plain SL/TP model.
RSI2_TIME_EXIT_BARS = config.get_int("SILVER_RSI2_TIME_EXIT_BARS", 8)
RSI2_BACKSTOP_TP_ATR = config.get_float("SILVER_RSI2_BACKSTOP_TP_ATR", 6.0)

# --- Trend / confluence ---
CLOUD_FAST = config.get_int("SILVER_CLOUD_FAST", 34)
CLOUD_SLOW = config.get_int("SILVER_CLOUD_SLOW", 134)
HTF_TIMEFRAME = config.get_str("SILVER_HTF_TIMEFRAME", "4h")
HTF_ALIGN_BONUS = config.get_float("SILVER_HTF_ALIGN_BONUS", 8.0)
HTF_OPPOSE_PENALTY = config.get_float("SILVER_HTF_OPPOSE_PENALTY", 12.0)
CONFLUENCE_BONUS = config.get_float("SILVER_CONFLUENCE_BONUS", 12.0)
MIN_CONF = config.get_float("SILVER_MIN_CONF", 55.0)
MAX_CONF = 95.0

# Session gate — silver's liquidity vacuum around the COMEX settle/close is worse
# than gold's (wider spreads on an already 2.3×-vol instrument).
DEAD_HOURS_UTC = set(config.get_list("SILVER_DEAD_HOURS_UTC", ["21", "22"]))
QUIET_HOURS_UTC = set(config.get_list("SILVER_QUIET_HOURS_UTC", ["23", "0", "1", "2", "3", "4", "5"]))
QUIET_PENALTY = config.get_float("SILVER_QUIET_PENALTY", 10.0)

# Whipsaw / session-open cooldown (same mechanics as gold; silver chops harder).
WHIPSAW_GUARD = config.get_bool("SILVER_WHIPSAW_GUARD", True)
CONTRA_COOLDOWN_MIN = config.get_int("SILVER_CONTRA_COOLDOWN_MIN", 30)
SESSION_COOLDOWN_MIN = config.get_int("SILVER_SESSION_COOLDOWN_MIN", 45)
SESSION_WINDOW_MIN = config.get_int("SILVER_SESSION_WINDOW_MIN", 30)
SESSION_MIN_CONF = config.get_float("SILVER_SESSION_MIN_CONF", 65.0)

ATR_WINDOW = config.get_int("SILVER_ATR_WINDOW", 14)


def atr(high, low, close, period=ATR_WINDOW):
    return _atr(high, low, close, period)


def _src_bar(df):
    """Feed dedupe tag: UTC timestamp of the closed bar a signal was read from.
    Without it, a 1h-sourced signal re-anchored to live spot re-fires each 15m
    scan at a *different* price, defeating the price-equality dedupe fallback
    (the gold S3 duplicate bug of 2026-07-08)."""
    return datetime.fromtimestamp(int(df["timestamp"].iloc[-1]) // 1000,
                                  tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ============================================
# S1: WICK-REJECTION SWEEP FADE (with-trend)
# ============================================

def s1_wick_rejection(df, atr_now, price):
    """Failed stop-hunt against the cloud trend, read on the last CLOSED bar.

    Closed-bar semantics matter here: a forming bar's high/low can't un-print,
    but its close can migrate back through the swept level and un-make the
    reclaim — so the signal bar must be closed. The scanner loop runs
    clock-aligned right after bar close, so `price` ≈ that close; stop/TP are
    re-anchored to `price` anyway so risk is exactly k×ATR from the real entry.
    """
    o = df["open"].values
    h = df["high"].values
    l = df["low"].values
    c = df["close"].values
    if len(c) < CLOUD_SLOW + SWEEP_LOOKBACK + 5 or not atr_now or np.isnan(atr_now):
        return None

    trend = cloud_direction(c, CLOUD_FAST, CLOUD_SLOW)

    i = -1  # last closed bar (still-forming bar already dropped by caller)
    bar_rng = h[i] - l[i]
    if bar_rng <= 0:
        return None
    lo_prev = l[i - SWEEP_LOOKBACK:i].min()
    hi_prev = h[i - SWEEP_LOOKBACK:i].max()
    dn_wick = min(o[i], c[i]) - l[i]
    up_wick = h[i] - max(o[i], c[i])

    if (trend == "BUY" and l[i] < lo_prev and c[i] > lo_prev
            and dn_wick >= WICK_MIN_ATR * atr_now and dn_wick / bar_rng >= WICK_MIN_FRAC):
        return {"strategy": "wick_rejection", "direction": "BUY", "conf": CONF_WICK,
                "stop": price - WICK_STOP_ATR * atr_now, "tp": price + WICK_TP_ATR * atr_now,
                "src_bar": _src_bar(df),
                "note": f"stop-hunt below {SWEEP_LOOKBACK}-bar low {lo_prev:.3f} rejected "
                        f"(wick {dn_wick:.3f} = {dn_wick/atr_now:.1f}×ATR, "
                        f"{dn_wick/bar_rng:.0%} of bar), cloud green"}
    if (trend == "SELL" and h[i] > hi_prev and c[i] < hi_prev
            and up_wick >= WICK_MIN_ATR * atr_now and up_wick / bar_rng >= WICK_MIN_FRAC):
        return {"strategy": "wick_rejection", "direction": "SELL", "conf": CONF_WICK,
                "stop": price + WICK_STOP_ATR * atr_now, "tp": price - WICK_TP_ATR * atr_now,
                "src_bar": _src_bar(df),
                "note": f"stop-hunt above {SWEEP_LOOKBACK}-bar high {hi_prev:.3f} rejected "
                        f"(wick {up_wick:.3f} = {up_wick/atr_now:.1f}×ATR, "
                        f"{up_wick/bar_rng:.0%} of bar), cloud red"}
    return None


# ============================================
# S2: CONNORS RSI(2) PULLBACK (1h source + time exit)
# ============================================

def s2_rsi2_pullback(price):
    """Connors RSI(2) dip fade, self-fetched from 1h regardless of scan TF —
    same pattern as gold-scanner S3. Trigger + SMA200 read on the last CLOSED
    1h bar; stop/TP re-anchored to the live entry price."""
    try:
        df1h = ctrader_feed.get_trendbars(CTRADER_SYMBOL, RSI2_TIMEFRAME, count=RSI2_LOOKBACK)
    except Exception as e:
        print(f"⚠️ RSI2 {RSI2_TIMEFRAME} fetch failed: {str(e)[:60]}")
        return None
    if df1h is None or len(df1h) < RSI2_MA + 5:
        return None
    interval_s = ctrader_feed.TIMEFRAMES.get(RSI2_TIMEFRAME, (0, 60))[1] * 60
    if int(df1h["timestamp"].iloc[-1]) // 1000 + interval_s > time.time():
        df1h = df1h.iloc[:-1]
    if len(df1h) < RSI2_MA + 5:
        return None

    atr_1h = atr(df1h["high"].values, df1h["low"].values, df1h["close"].values)[-1]
    sig = _trend.rsi2_pullback(
        df1h, atr_1h,
        buy_level=RSI2_BUY_LVL, sell_level=RSI2_SELL_LVL, trend_ma=RSI2_MA,
        stop_atr=RSI2_STOP_ATR, tp_atr=RSI2_TP_ATR, conf=CONF_RSI2,
    )
    if sig is None:
        return None
    if sig["direction"] == "BUY":
        sig["stop"], sig["tp"] = price - RSI2_STOP_ATR * atr_1h, price + RSI2_TP_ATR * atr_1h
    else:
        sig["stop"], sig["tp"] = price + RSI2_STOP_ATR * atr_1h, price - RSI2_TP_ATR * atr_1h
    sig["note"] += f" [{RSI2_TIMEFRAME}]"
    sig["src_bar"] = _src_bar(df1h)

    if RSI2_TIME_EXIT_BARS > 0:
        tf_min = ctrader_feed.TIMEFRAMES.get(RSI2_TIMEFRAME, (0, 60))[1]
        sig["time_exit_min"] = RSI2_TIME_EXIT_BARS * tf_min
        buf = RSI2_BACKSTOP_TP_ATR * atr_1h
        sig["tp"] = price + buf if sig["direction"] == "BUY" else price - buf
        sig["note"] += f" [time-exit {sig['time_exit_min']}m, backstop TP {RSI2_BACKSTOP_TP_ATR:g}×ATR]"
    return sig


# ============================================
# HTF TREND (4h EMA cloud direction)
# ============================================

def htf_trend():
    try:
        df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, HTF_TIMEFRAME, count=CLOUD_SLOW + 60)
        if df is None or len(df) < CLOUD_SLOW + 5:
            return None
        return cloud_direction(df["close"].values, CLOUD_FAST, CLOUD_SLOW)
    except Exception as e:
        print(f"⚠️ HTF trend unavailable: {str(e)[:60]}")
        return None


# ============================================
# SCAN
# ============================================

def _load_feed(feed_path):
    """Recent feed entries (for the whipsaw guard). [] on any read/parse error."""
    try:
        with open(feed_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def scan(timeframe, verbose, account_size, risk_percent,
         use_wick=True, use_rsi2=True, use_session=True,
         feed_path=FEED_PATH):
    now = datetime.now(timezone.utc)
    print(f"\n{'='*100}")
    print(f"🥈 SILVER SCANNER (cTrader {CTRADER_SYMBOL}): {timeframe} | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"   Strategies: wick_rejection={'✅' if use_wick else '❌'} "
          f"rsi2_pullback={'✅' if use_rsi2 else '❌'} | session gate={'✅' if use_session else '❌'}")
    print(f"{'='*100}")

    if use_session and str(now.hour) in DEAD_HOURS_UTC:
        print(f"🌙 Dead hour ({now.hour}:00 UTC — COMEX settle/close). No entries taken.")
        return

    df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=LOOKBACK)
    if df is None or len(df) < CLOUD_SLOW + SWEEP_LOOKBACK + 10:
        print(f"❌ insufficient data ({0 if df is None else len(df)} bars)")
        return

    price = float(df["close"].values[-1])  # live spot = entry anchor for both strategies

    # S1 reads the last CLOSED bar (the wick/reclaim can un-make on a forming bar).
    interval_s = ctrader_feed.TIMEFRAMES.get(timeframe, (0, 15))[1] * 60
    df_closed = df
    if int(df["timestamp"].iloc[-1]) // 1000 + interval_s > time.time():
        df_closed = df.iloc[:-1]
    closed = df_closed["close"].values
    atr_now = atr(df_closed["high"].values, df_closed["low"].values, closed)[-1]
    rsi14 = float(rsi(closed, 14)[-1])

    candidates = []
    if use_wick:
        candidates.append(s1_wick_rejection(df_closed, atr_now, price))
    if use_rsi2:
        candidates.append(s2_rsi2_pullback(price))
    candidates = [c for c in candidates if c]

    if verbose:
        e34, e134 = ema(closed, CLOUD_FAST)[-1], ema(closed, CLOUD_SLOW)[-1]
        print(f"   price={price:.3f}  ATR({ATR_WINDOW})={atr_now:.3f}  RSI14={rsi14:.1f}  "
              f"cloud={'green' if e34 > e134 else 'red'} ({min(e34,e134):.3f}-{max(e34,e134):.3f})")

    if not candidates:
        print("📭 No setups on this scan.")
        return

    htf = htf_trend()
    best, conf = _trend.combine(
        candidates, htf,
        confluence_bonus=CONFLUENCE_BONUS, htf_align_bonus=HTF_ALIGN_BONUS,
        htf_oppose_penalty=HTF_OPPOSE_PENALTY, max_conf=MAX_CONF,
    )
    if best == "conflict":
        print("⚖️  Conflicting directions across strategies — standing aside:")
        for c in candidates:
            print(f"   {c['direction']:<4} {c['strategy']}: {c['note']}")
        return

    if use_session and str(now.hour) in QUIET_HOURS_UTC:
        conf -= QUIET_PENALTY
        conf = min(conf, MAX_CONF)

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

    print(f"\n🎯 {best['direction']} {FEED_SYMBOL} @ ${price:.3f}  (confidence {conf:.0f}%)")
    print(f"   strategy: {best['strategy']}"
          + (f"  +confluence: {', '.join(c['strategy'] for c in candidates if c is not best)}"
             if len(candidates) > 1 else ""))
    print(f"   {best['note']}")
    print(f"   HTF({HTF_TIMEFRAME}) trend: {htf or 'n/a'}"
          f" ({'aligned ✅' if htf == best['direction'] else 'opposed ⚠️' if htf else '—'})")
    risk = abs(price - best["stop"])
    reward = abs(best["tp"] - price)
    if risk:
        print(f"   🛑 SL ${best['stop']:.3f}  🎯 TP ${best['tp']:.3f}  "
              f"(risk ${risk:.3f} / reward ${reward:.3f} → R:R {reward/risk:.2f})")
    if best.get("time_exit_min"):
        print(f"   ⏱  time-exit in {best['time_exit_min']}m (TP is a far backstop; doochybot closes at market)")
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
        "stop_loss": round(best["stop"], PX_DECIMALS),
        "tp1": round(best["tp"], PX_DECIMALS),
        "time_exit_min": best.get("time_exit_min"),   # set only by S2 time-exit; None otherwise
        "src_bar": best.get("src_bar"),               # closed source-bar ts (feed dedupe key)
    }
    _core_write_to_feed(
        [signal], timeframe,
        signal_source=SIGNAL_SOURCE,
        btc_state=None,
        feed_path=feed_path,
        futures_symbols=(FEED_SYMBOL,),          # silver carries btc_state = null
        readvancing_fade=guards._is_readvancing_fade,
    )


# ============================================
# CLI / RUN
# ============================================

def parse_args():
    p = argparse.ArgumentParser(description="Silver (XAGUSD) multi-strategy scanner")
    p.add_argument("-tf", "--timeframe", default=config.get_str("SILVER_TIMEFRAME", "15m"),
                   help="1m 5m 15m 30m 1h 2h 4h 6h 12h 1d (default: 15m; .env SILVER_TIMEFRAME)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--account-size", type=float, default=config.get_float("ACCOUNT_SIZE", 10000))
    p.add_argument("--risk", type=float, default=config.get_float("RISK", 0.01),
                   help="risk per trade (default 0.01 = 1%%)")
    p.add_argument("--min-conf", type=float, default=None, help=f"override SILVER_MIN_CONF ({MIN_CONF})")
    p.add_argument("--no-wick", action="store_true", help="disable wick-rejection sweep fade (S1)")
    p.add_argument("--no-rsi2", action="store_true", help="disable Connors RSI(2) (S2)")
    p.add_argument("--no-session-filter", action="store_true", help="ignore dead/quiet hour gates")
    p.add_argument("--loop", type=int, default=config.get_int("SILVER_LOOP", 0),
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
                 use_wick=not args.no_wick,
                 use_rsi2=not args.no_rsi2,
                 use_session=not args.no_session_filter)
            health.report_ok("silver-scanner")
        except Exception as e:
            print(f"❌ scan failed: {str(e)[:100]}")
            health.report_error("silver-scanner", e)
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
