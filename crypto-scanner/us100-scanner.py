#!/usr/bin/env python3
"""
NASDAQ-100 (US100) signal scanner — cTrader feed → data/alerts.json (market entries).

A 1h trend-momentum scanner for the tech index. Distinct in character from the
metals/crypto stack: indices trend cleanly and the ONE edge that survived a
2.2-year, regime-inclusive walk-forward (2026-07-09) is momentum, not reversion.

  S1  MOMENTUM BREAKOUT (donchian)  — the only validated US100 edge. First 1h
      close beyond the prior-N-bar high/low, taken ONLY with BOTH the 4h AND the
      1d EMA34/134 cloud on the breakout side. ATR stop (1.5×) / target (2.0×).
      Backtest (1h, Apr-2024→Jul-2026, SL-first, 2pt cost): +0.126 avgR, n=253,
      49% win, POSITIVE IN ALL THREE REGIME-THIRDS. The donchian lookback sits on
      a broad positive plateau (lb50..100 all +0.10..0.14), so it is not a fitted
      point. The edge is long-DOMINANT: the BUY side is well-sampled (n=234,
      positive every third); the SELL side is thin (n=19, positive but
      under-validated, because US100's HTF cloud was rarely red over the sample).
      So the scanner leans long by construction — that is the honest edge, not a
      bug. (15m US100 was tested first and REJECTED: only long-only bull-beta with
      a NEGATIVE short side — no validated edge. See memory.)

  Explicitly REJECTED on 1h US100 (do not re-add without new evidence): Connors
  RSI(2) (negative both sides — worked for gold, NOT here), EMA5/8 cloud pullback
  (negative), VWAP reclaim (flat/inconsistent). US100 does not pay to fade or to
  pull-back-buy; it pays to break out with the higher-timeframe trend.

  GATES
      • Hard 4h + 1d cloud gate at generation (= exactly the backtested subset).
      • Dead hour (21-22 UTC — CME settlement/maintenance break, thin) → no entries.
      • Whipsaw guard: drop a direction flip within a cooldown (chop).
      • src_bar feed dedupe (the closed 1h bar) + feed-level no-re-arm guard.

Usage:
    python us100-scanner.py                 # 1h
    python us100-scanner.py -v --loop 15
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone

import numpy as np

import ctrader_feed
from core import config, guards, health
from core.feed import write_to_feed as _core_write_to_feed
from core.strategy import calculate_position_size
from core.trend import ema, atr as _atr, wilder_rsi as rsi, cloud_direction
from core import trend as _trend

# ============================================
# CONFIG (.env-tunable; U100_* prefix)
# ============================================
CTRADER_SYMBOL = "US100"
FEED_SYMBOL = "US100"
SIGNAL_SOURCE = "us100_scanner"
FEED_PATH = "./data/alerts.json"

LOOKBACK = config.get_int("U100_LOOKBACK", 400)          # 1h bars: EMA134 warmup + donchian + buffer
ATR_WINDOW = config.get_int("U100_ATR_WINDOW", 14)

CLOUD_FAST = config.get_int("U100_CLOUD_FAST", 34)
CLOUD_SLOW = config.get_int("U100_CLOUD_SLOW", 134)

# --- S1: momentum breakout (donchian) ---
DONCHIAN_LB = config.get_int("U100_DONCHIAN_LB", 60)     # prior-N extreme; positive plateau lb50..100
MOM_STOP_ATR = config.get_float("U100_MOM_STOP_ATR", 1.5)
MOM_TP_ATR = config.get_float("U100_MOM_TP_ATR", 2.0)
CONF_MOM = config.get_float("U100_CONF_MOM", 62.0)

# --- HTF gates ---
HTF4_TIMEFRAME = config.get_str("U100_HTF4_TIMEFRAME", "4h")
HTFD_TIMEFRAME = config.get_str("U100_HTFD_TIMEFRAME", "1d")
HTF_ALIGN_BONUS = config.get_float("U100_HTF_ALIGN_BONUS", 8.0)
HTF_OPPOSE_PENALTY = config.get_float("U100_HTF_OPPOSE_PENALTY", 12.0)
CONFLUENCE_BONUS = config.get_float("U100_CONFLUENCE_BONUS", 10.0)
MIN_CONF = config.get_float("U100_MIN_CONF", 55.0)
MAX_CONF = 95.0

# Session gate: skip the CME settlement/maintenance break (21-22 UTC — thin/gappy).
DEAD_HOURS_UTC = set(config.get_list("U100_DEAD_HOURS_UTC", ["21", "22"]))

# Whipsaw guard: drop a direction flip within a cooldown (chop). The session-open
# refinement is gold-specific; here we use the plain contra-flip cooldown only.
WHIPSAW_GUARD = config.get_bool("U100_WHIPSAW_GUARD", True)
CONTRA_COOLDOWN_MIN = config.get_int("U100_CONTRA_COOLDOWN_MIN", 120)   # 2h on a 1h scanner


# ============================================
# HELPERS
# ============================================

def atr(high, low, close, period=ATR_WINDOW):
    return _atr(high, low, close, period)


def _closed_bars(timeframe, count):
    """Fetch trendbars and drop the still-forming last bar. None on failure/short."""
    df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=count)
    if df is None or len(df) < 5:
        return None
    interval_s = ctrader_feed.TIMEFRAMES.get(timeframe, (0, 60))[1] * 60
    if int(df["timestamp"].iloc[-1]) // 1000 + interval_s > time.time():
        df = df.iloc[:-1]
    return df


def _src_bar(df):
    """Feed dedupe tag: UTC timestamp of the last CLOSED bar the signal was read
    from (the --loop 15 cadence re-detects the same 1h bar until it rolls)."""
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
# STRATEGY  (reads the last CLOSED 1h bar; stop/TP re-anchored to live price)
# ============================================

def s1_momentum(df, price, htf4, htfd):
    """S1: donchian-N breakout, hard-gated to BOTH the 4h and 1d clouds.

    Fires on the FIRST close beyond the prior-N extreme (the previous bar was
    inside), so a persistent breakout doesn't re-arm every bar. Both HTF clouds
    must be on the breakout side — exactly the backtested subset."""
    if htf4 is None or htfd is None:
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
    if htf4 != direction or htfd != direction:       # hard 4h + 1d gate
        return None

    if direction == "BUY":
        stop, tp = price - MOM_STOP_ATR * atr_now, price + MOM_TP_ATR * atr_now
    else:
        stop, tp = price + MOM_STOP_ATR * atr_now, price - MOM_TP_ATR * atr_now
    return {"strategy": "momentum_breakout", "direction": direction, "conf": CONF_MOM,
            "stop": stop, "tp": tp, "src_bar": _src_bar(df),
            "note": f"{DONCHIAN_LB}-bar breakout {'above' if direction=='BUY' else 'below'} "
                    f"{level:.1f}, 4h+1d cloud aligned"}


# ============================================
# SCAN
# ============================================

def _load_feed(feed_path):
    try:
        with open(feed_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def scan(timeframe, verbose, account_size, risk_percent, use_session=True, feed_path=FEED_PATH):
    now = datetime.now(timezone.utc)
    print(f"\n{'='*100}")
    print(f"💻 US100 SCANNER (cTrader {CTRADER_SYMBOL}): {timeframe} | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"   Strategy: momentum_breakout (donchian-{DONCHIAN_LB}, 4h+1d gated) "
          f"| session gate={'✅' if use_session else '❌'}")
    print(f"{'='*100}")

    if use_session and str(now.hour) in DEAD_HOURS_UTC:
        print(f"🌙 Dead hour ({now.hour}:00 UTC — CME settlement break). No entries taken.")
        return

    df = _closed_bars(timeframe, LOOKBACK)
    if df is None or len(df) < CLOUD_SLOW + DONCHIAN_LB + 5:
        print(f"❌ insufficient data ({0 if df is None else len(df)} bars)")
        return

    close = df["close"].values
    price = float(close[-1])
    atr_now = atr(df["high"].values, df["low"].values, close)[-1]
    rsi14 = float(rsi(close, 14)[-1])

    htf4 = _htf_cloud(HTF4_TIMEFRAME)
    htfd = _htf_cloud(HTFD_TIMEFRAME)

    candidates = [c for c in [s1_momentum(df, price, htf4, htfd)] if c]

    if verbose:
        e34, e134 = ema(close, CLOUD_FAST)[-1], ema(close, CLOUD_SLOW)[-1]
        print(f"   price={price:.1f}  ATR({ATR_WINDOW})={atr_now:.1f}  RSI14={rsi14:.1f}  "
              f"1h-cloud={'green' if e34 > e134 else 'red'}  4h={htf4 or 'n/a'}  1d={htfd or 'n/a'}")

    if not candidates:
        print("📭 No setups on this scan.")
        return

    best, conf = _trend.combine(
        candidates, htf4,
        confluence_bonus=CONFLUENCE_BONUS, htf_align_bonus=HTF_ALIGN_BONUS,
        htf_oppose_penalty=HTF_OPPOSE_PENALTY, max_conf=MAX_CONF,
    )

    if WHIPSAW_GUARD:
        blocked, why = guards.gold_whipsaw_block(
            best["direction"], _load_feed(feed_path), now,
            cooldown_min=CONTRA_COOLDOWN_MIN, session_cooldown_min=CONTRA_COOLDOWN_MIN,
            session_window_min=0,                       # 0 = no session-open refinement (gold-specific)
            symbol=FEED_SYMBOL, signal_source=SIGNAL_SOURCE)
        if blocked:
            print(f"🔁 Whipsaw guard — standing aside: {why}")
            return

    print(f"\n🎯 {best['direction']} {FEED_SYMBOL} @ {price:.1f}  (confidence {conf:.0f}%)")
    print(f"   {best['note']}")
    print(f"   HTF: 4h {htf4 or 'n/a'} / 1d {htfd or 'n/a'} "
          f"({'aligned ✅' if htf4 == best['direction'] else '—'})")
    risk = abs(price - best["stop"])
    reward = abs(best["tp"] - price)
    print(f"   🛑 SL {best['stop']:.1f}  🎯 TP {best['tp']:.1f}  "
          f"(risk {risk:.1f} / reward {reward:.1f} → R:R {reward/risk:.2f})" if risk else "")
    pos = calculate_position_size(price, best["stop"], conf, account_size, risk_percent)
    print(f"   📊 size {pos['size']:.4f} (${pos['value']:.2f}) | risk ${pos['risk_amount']:.2f} "
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
        futures_symbols=(FEED_SYMBOL,),                 # index carries btc_state = null
        readvancing_fade=guards._is_readvancing_fade,
    )


# ============================================
# CLI / RUN
# ============================================

def parse_args():
    p = argparse.ArgumentParser(description="NASDAQ-100 (US100) momentum scanner")
    p.add_argument("-tf", "--timeframe", default=config.get_str("U100_TIMEFRAME", "1h"),
                   help="source TF (default 1h; U100_TIMEFRAME)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--account-size", type=float, default=config.get_float("ACCOUNT_SIZE", 10000))
    p.add_argument("--risk", type=float, default=config.get_float("RISK", 0.01))
    p.add_argument("--min-conf", type=float, default=None, help=f"override U100_MIN_CONF ({MIN_CONF})")
    p.add_argument("--no-session-filter", action="store_true", help="ignore dead-hour gate")
    p.add_argument("--loop", type=int, default=config.get_int("U100_LOOP", 0),
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
                 use_session=not args.no_session_filter)
            health.report_ok("us100-scanner")
        except Exception as e:
            print(f"❌ scan failed: {str(e)[:100]}")
            health.report_error("us100-scanner", e)
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
