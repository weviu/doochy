#!/usr/bin/env python3
"""
Gold (XAUUSD) signal scanner — cTrader feed → data/alerts.json (market entries).

Three independent, documented strategies, combined by confluence. Deliberately
distinct from metals-scanner.py (Nadaraya-Watson mean-reversion fade) and
xau-scanner.py (AO/BearsPower/MACD momentum EA):

  S1  EMA CLOUD PULLBACK  (docs/hmm.md) — sourced from 1h, like S3
      Trend = EMA34/EMA134 cloud (green when fast>slow). With price AND both
      fast EMAs (5, 8) on the trend side of the cloud, a pullback is EMA5
      crossing against EMA8; the ENTRY is EMA5 crossing back in the trend
      direction. Stop beyond the far side of the cloud, TP at 2R (per the doc).
      A 7-month walk-forward backtest (2026-07-09) showed the setup is ~flat on
      15m gold (+0.06 avgR HTF-aligned) but strongly positive on 1h (+0.52 avgR
      aligned, n=61 same window; +0.51 over 16 months) — so S1 reads the last
      CLOSED 1h bar regardless of scan TF, with stop/TP re-anchored to the live
      entry price.

  S2  ASIAN RANGE → LONDON BREAKOUT  (intraday TFs only: 5m/15m/30m)
      Gold's volatility is session-driven: the 00:00–07:00 UTC (Asian) range is
      typically accumulation, and London open (07:00 UTC) produces the day's
      directional move. Signal = FIRST bar close outside the Asian range during
      the London window, with range-width sanity bounds (too tight = noise,
      too wide = news day / range already spent). Stop at range midpoint,
      TP = one range-height measured move.

  S3  CONNORS RSI(2) PULLBACK  (Connors & Alvarez, "Short Term Trading
      Strategies That Work") — long when price > SMA200 and RSI(2) < 10,
      short when price < SMA200 and RSI(2) > 90. A with-trend dip fade; the
      repo's volatility-spike guard penalises it during range explosions,
      where snap-back fades are least reliable.

  CONFLUENCE + GATES
      • 4h EMA34/134 cloud: +CONF if aligned, −CONF if opposed.
      • ≥2 strategies agreeing on direction → confluence bonus; strategies
        firing in OPPOSITE directions on the same scan → both dropped.
      • Session gate (thin-market protection for gold):
          - dead hours (21–22 UTC: COMEX settle / daily close) → no signals;
          - quiet Asian hours → confidence penalty.
      • Feed-level no-re-arm guard (core/guards) as in the other scanners.

Usage:
    python gold-scanner.py                # default 15m
    python gold-scanner.py -tf 1h -v
    python gold-scanner.py --loop 15      # rescan every 15 min
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

# ============================================
# CONFIG (.env-tunable; see core/config.py)
# ============================================
CTRADER_SYMBOL = "XAUUSD"
FEED_SYMBOL = "XAUUSD"
SIGNAL_SOURCE = "gold_scanner"
FEED_PATH = "./data/alerts.json"

LOOKBACK = config.get_int("GOLD_LOOKBACK", 600)  # bars: SMA200 + EMA134 warmup + Asian day

# --- S1: EMA cloud pullback (docs/hmm.md) ---
# Sourced from 1h (see module docstring): 15m S1 is noise (+0.06 avgR aligned),
# 1h S1 is the strongest edge measured in this scanner (+0.52 avgR aligned).
# Shares S3's closed-bar series, so the source TF is GOLD_RSI2_TIMEFRAME.
CLOUD_SLOW = config.get_int("GOLD_CLOUD_SLOW", 134)
CLOUD_FAST = config.get_int("GOLD_CLOUD_FAST", 34)
RIBBON_FAST = config.get_int("GOLD_RIBBON_FAST", 5)
RIBBON_SLOW = config.get_int("GOLD_RIBBON_SLOW", 8)
CLOUD_RR = config.get_float("GOLD_CLOUD_RR", 2.0)            # TP = 2× risk (per the doc)
CLOUD_STOP_ATR_BUF = config.get_float("GOLD_CLOUD_STOP_ATR_BUF", 0.25)  # stop buffer beyond cloud
CONF_CLOUD = config.get_float("GOLD_CONF_CLOUD", 65.0)

# --- S2: Asian range → London breakout ---
ASIA_START_H = config.get_int("GOLD_ASIA_START_H", 0)        # UTC
ASIA_END_H = config.get_int("GOLD_ASIA_END_H", 7)            # UTC (exclusive)
LONDON_END_H = config.get_int("GOLD_LONDON_END_H", 14)       # breakout window: ASIA_END_H..this
RANGE_MIN_PCT = config.get_float("GOLD_RANGE_MIN_PCT", 0.15) # Asian range width bounds (% of price)
# Max width raised 1.20 → 2.50 (2026-07-09 backtest, 7mo 15m): the tight cap was
# rejecting good trending days (incl. any day whose Asian range holds spillover from
# the prior session — e.g. Jul 9's rally). 1.20% cap: +0.03 avgR / n=54; 2.50%
# news-day-only ceiling: +0.14 avgR / n=95 (+0.47 avgR on the HTF-aligned subset,
# which is what the conf gates actually let through).
RANGE_MAX_PCT = config.get_float("GOLD_RANGE_MAX_PCT", 2.50)
CONF_BREAKOUT = config.get_float("GOLD_CONF_BREAKOUT", 62.0)

# --- S3: Connors RSI(2) ---
# Sourced from 1h, NOT the scan TF: a 5000-bar/8-month backtest showed the RSI2 dip
# fade has NO edge on 15m gold (negative at every geometry) but a real edge on 1h.
# Geometry flipped from the old TP1.25/SL2.5 (0.5 R:R — the worst config tested, needs
# ~67% wins) to TP2.0/SL1.5, which turns 1h expectancy positive on pure SL/TP.
RSI2_TIMEFRAME = config.get_str("GOLD_RSI2_TIMEFRAME", "1h")  # TF where RSI2 actually works
RSI2_LOOKBACK = config.get_int("GOLD_RSI2_LOOKBACK", 300)    # SMA200 + warmup on the 1h series
RSI2_BUY_LVL = config.get_float("GOLD_RSI2_BUY", 10.0)
RSI2_SELL_LVL = config.get_float("GOLD_RSI2_SELL", 90.0)
RSI2_MA = config.get_int("GOLD_RSI2_MA", 200)                # trend filter SMA
RSI2_STOP_ATR = config.get_float("GOLD_RSI2_STOP_ATR", 1.5)  # was 2.5 (see backtest)
RSI2_TP_ATR = config.get_float("GOLD_RSI2_TP_ATR", 2.0)      # was 1.25 — stop capping winners
CONF_RSI2 = config.get_float("GOLD_CONF_RSI2", 58.0)
# Time-based exit — the validated S3 edge: doochybot closes the position this many bars
# (of RSI2_TIMEFRAME) after fill, at market, SL still armed. 8 bars (=8h on 1h) was chosen
# for the prop account (lower drawdown than 16). 0 disables → falls back to the TP2/SL1.5
# model. When on, the near TP is replaced by a far backstop so the timer isn't clipped.
RSI2_TIME_EXIT_BARS = config.get_int("GOLD_RSI2_TIME_EXIT_BARS", 8)
RSI2_BACKSTOP_TP_ATR = config.get_float("GOLD_RSI2_BACKSTOP_TP_ATR", 6.0)

# --- Confluence / gates ---
HTF_TIMEFRAME = config.get_str("GOLD_HTF_TIMEFRAME", "4h")
HTF_ALIGN_BONUS = config.get_float("GOLD_HTF_ALIGN_BONUS", 8.0)
HTF_OPPOSE_PENALTY = config.get_float("GOLD_HTF_OPPOSE_PENALTY", 12.0)
CONFLUENCE_BONUS = config.get_float("GOLD_CONFLUENCE_BONUS", 12.0)
MIN_CONF = config.get_float("GOLD_MIN_CONF", 55.0)
MAX_CONF = 95.0

# Session gate: no fresh entries around the COMEX settle/daily close (liquidity
# vacuum + spread blowout); Asian quiet hours get a confidence haircut.
DEAD_HOURS_UTC = set(config.get_list("GOLD_DEAD_HOURS_UTC", ["21", "22"]))
QUIET_HOURS_UTC = set(config.get_list("GOLD_QUIET_HOURS_UTC", ["23", "0", "1", "2", "3", "4", "5"]))
QUIET_PENALTY = config.get_float("GOLD_QUIET_PENALTY", 10.0)

# Whipsaw / session-open cooldown: suppress a gold signal whose direction flips against a
# recently-emitted one (chop), stricter around Tokyo/London/NY opens where flips cluster.
WHIPSAW_GUARD = config.get_bool("GOLD_WHIPSAW_GUARD", True)
CONTRA_COOLDOWN_MIN = config.get_int("GOLD_CONTRA_COOLDOWN_MIN", 30)   # pause after a direction flip
SESSION_COOLDOWN_MIN = config.get_int("GOLD_SESSION_COOLDOWN_MIN", 45)  # stricter inside a session open
SESSION_WINDOW_MIN = config.get_int("GOLD_SESSION_WINDOW_MIN", 30)     # width of each session-open window
SESSION_MIN_CONF = config.get_float("GOLD_SESSION_MIN_CONF", 65.0)     # min conf to emit inside a session open

ATR_WINDOW = config.get_int("GOLD_ATR_WINDOW", 14)


# ============================================
# INDICATORS / STRATEGIES  (shared — see core/trend.py)
# ============================================
from core.trend import ema, sma, atr as _atr, wilder_rsi as rsi, cloud_direction
from core import trend as _trend


def atr(high, low, close, period=ATR_WINDOW):
    return _atr(high, low, close, period)


def _closed_bars(timeframe, count):
    """Fetch trendbars and drop the still-forming last bar (signals read closed
    candles only — no intra-bar repaint). None on fetch failure/short series."""
    df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=count)
    if df is None or len(df) < 5:
        return None
    interval_s = ctrader_feed.TIMEFRAMES.get(timeframe, (0, 60))[1] * 60
    if int(df["timestamp"].iloc[-1]) // 1000 + interval_s > time.time():
        df = df.iloc[:-1]
    return df


def _src_bar(df):
    """Feed dedupe tag: UTC timestamp of the closed bar a signal was read from.
    The same source bar re-detected on later scan loops is the SAME signal."""
    return datetime.fromtimestamp(int(df["timestamp"].iloc[-1]) // 1000,
                                  tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def s1_cloud_pullback(df1h, price):
    """docs/hmm.md: EMA34/134 cloud trend + EMA5/8 pullback-resume cross, read on
    the last CLOSED 1h bar (no edge on 15m — see module docstring). The stop stays
    structural (beyond the 1h cloud); TP is re-anchored to the live entry price so
    the emitted R:R matches the fill."""
    if df1h is None or len(df1h) < CLOUD_SLOW + 10:
        return None
    atr_1h = atr(df1h["high"].values, df1h["low"].values, df1h["close"].values)[-1]
    sig = _trend.cloud_pullback(
        df1h, atr_1h,
        cloud_fast=CLOUD_FAST, cloud_slow=CLOUD_SLOW,
        ribbon_fast=RIBBON_FAST, ribbon_slow=RIBBON_SLOW,
        rr=CLOUD_RR, stop_atr_buf=CLOUD_STOP_ATR_BUF, conf=CONF_CLOUD,
    )
    if sig is None:
        return None
    risk = price - sig["stop"] if sig["direction"] == "BUY" else sig["stop"] - price
    if risk <= 0:
        return None                     # live price already through the structural stop
    sig["tp"] = price + CLOUD_RR * risk if sig["direction"] == "BUY" else price - CLOUD_RR * risk
    sig["note"] += f" [{RSI2_TIMEFRAME}]"
    sig["src_bar"] = _src_bar(df1h)
    return sig


def s2_asian_breakout(df, timeframe):
    """First close beyond today's 00:00–07:00 UTC range during the London window."""
    if timeframe not in ("5m", "15m", "30m"):
        return None
    ts = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    now = ts.iloc[-1]
    if not (ASIA_END_H <= now.hour < LONDON_END_H):
        return None

    today = ts.dt.date == now.date()
    asia = df[today & (ts.dt.hour >= ASIA_START_H) & (ts.dt.hour < ASIA_END_H)]
    if len(asia) < 3:
        return None
    hi, lo = asia["high"].max(), asia["low"].min()
    price, prev_close = df["close"].iloc[-1], df["close"].iloc[-2]

    width_pct = (hi - lo) / price * 100
    if not (RANGE_MIN_PCT <= width_pct <= RANGE_MAX_PCT):
        return None

    mid = (hi + lo) / 2
    rng = hi - lo
    # freshness: THIS bar is the first close outside the range
    if price > hi and prev_close <= hi:
        return {"strategy": "asian_breakout", "direction": "BUY", "conf": CONF_BREAKOUT,
                "stop": mid, "tp": hi + rng, "src_bar": _src_bar(df),
                "note": f"London close above Asian range {lo:.2f}-{hi:.2f} ({width_pct:.2f}%)"}
    if price < lo and prev_close >= lo:
        return {"strategy": "asian_breakout", "direction": "SELL", "conf": CONF_BREAKOUT,
                "stop": mid, "tp": lo - rng, "src_bar": _src_bar(df),
                "note": f"London close below Asian range {lo:.2f}-{hi:.2f} ({width_pct:.2f}%)"}
    return None


def s3_rsi2_pullback(df1h, price):
    """Connors RSI(2) dip fade — read from closed 1h bars (RSI2 has no edge on 15m
    gold; see backtest). Trigger + SMA200 trend filter come from the last CLOSED 1h
    bar to avoid intra-hour repaint; stop/TP are re-anchored to the live `price` so
    risk is exactly k×ATR from the actual market entry."""
    if df1h is None or len(df1h) < RSI2_MA + 5:
        return None
    atr_1h = atr(df1h["high"].values, df1h["low"].values, df1h["close"].values)[-1]
    sig = _trend.rsi2_pullback(
        df1h, atr_1h,
        buy_level=RSI2_BUY_LVL, sell_level=RSI2_SELL_LVL, trend_ma=RSI2_MA,
        stop_atr=RSI2_STOP_ATR, tp_atr=RSI2_TP_ATR, conf=CONF_RSI2,
    )
    if sig is None:
        return None
    # rsi2_pullback anchored stop/TP to the 1h close; re-anchor to the live entry so
    # the emitted R:R matches the price doochybot actually fills at.
    if sig["direction"] == "BUY":
        sig["stop"], sig["tp"] = price - RSI2_STOP_ATR * atr_1h, price + RSI2_TP_ATR * atr_1h
    else:
        sig["stop"], sig["tp"] = price + RSI2_STOP_ATR * atr_1h, price - RSI2_TP_ATR * atr_1h
    sig["note"] += f" [{RSI2_TIMEFRAME}]"
    sig["src_bar"] = _src_bar(df1h)

    # Time-based exit (the validated edge): hand doochybot a hold duration and replace the
    # near TP with a far backstop so the timer captures the full reversion, not a clipped 2R.
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
         use_cloud=True, use_breakout=True, use_rsi2=True, use_session=True,
         feed_path=FEED_PATH):
    now = datetime.now(timezone.utc)
    print(f"\n{'='*100}")
    print(f"🥇 GOLD SCANNER (cTrader {CTRADER_SYMBOL}): {timeframe} | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"   Strategies: cloud_pullback={'✅' if use_cloud else '❌'} "
          f"asian_breakout={'✅' if use_breakout else '❌'} rsi2_pullback={'✅' if use_rsi2 else '❌'} "
          f"| session gate={'✅' if use_session else '❌'}")
    print(f"{'='*100}")

    if use_session and str(now.hour) in DEAD_HOURS_UTC:
        print(f"🌙 Dead hour ({now.hour}:00 UTC — COMEX settle/close). No entries taken.")
        return

    df = ctrader_feed.get_trendbars(CTRADER_SYMBOL, timeframe, count=LOOKBACK)
    if df is None or len(df) < CLOUD_SLOW + 10:
        print(f"❌ insufficient data ({0 if df is None else len(df)} bars)")
        return

    close = df["close"].values
    price = float(close[-1])
    atr_now = atr(df["high"].values, df["low"].values, close)[-1]
    rsi14 = float(rsi(close, 14)[-1])

    # Shared closed-bar 1h series for the 1h-sourced strategies (S1 + S3). One fetch
    # per scan; RSI2_LOOKBACK (300) covers both warmups (SMA200, EMA134).
    df1h = None
    if use_cloud or use_rsi2:
        try:
            df1h = _closed_bars(RSI2_TIMEFRAME, RSI2_LOOKBACK)
        except Exception as e:
            print(f"⚠️ {RSI2_TIMEFRAME} fetch failed: {str(e)[:60]}")

    candidates = []
    if use_cloud:
        candidates.append(s1_cloud_pullback(df1h, price))
    if use_breakout:
        candidates.append(s2_asian_breakout(df, timeframe))
    if use_rsi2:
        candidates.append(s3_rsi2_pullback(df1h, price))
    candidates = [c for c in candidates if c]

    if verbose:
        e34, e134 = ema(close, CLOUD_FAST)[-1], ema(close, CLOUD_SLOW)[-1]
        print(f"   price={price:.2f}  ATR({ATR_WINDOW})={atr_now:.2f}  RSI14={rsi14:.1f}  "
              f"cloud={'green' if e34 > e134 else 'red'} ({min(e34,e134):.2f}-{max(e34,e134):.2f})")

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

    # Whipsaw / session-open guard: drop direction flips within a cooldown (chop), and
    # require higher conviction during Tokyo/London/NY opens where flips cluster.
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
    print(f"   HTF({HTF_TIMEFRAME}) trend: {htf or 'n/a'}"
          f" ({'aligned ✅' if htf == best['direction'] else 'opposed ⚠️' if htf else '—'})")
    risk = abs(price - best["stop"])
    reward = abs(best["tp"] - price)
    print(f"   🛑 SL ${best['stop']:.2f}  🎯 TP ${best['tp']:.2f}  "
          f"(risk ${risk:.2f} / reward ${reward:.2f} → R:R {reward/risk:.2f})" if risk else "")
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
        "stop_loss": round(best["stop"], 2),
        "tp1": round(best["tp"], 2),
        "time_exit_min": best.get("time_exit_min"),   # set only by S3 time-exit; None otherwise
        "src_bar": best.get("src_bar"),               # closed source-bar ts (feed dedupe key)
    }
    _core_write_to_feed(
        [signal], timeframe,
        signal_source=SIGNAL_SOURCE,
        btc_state=None,
        feed_path=feed_path,
        futures_symbols=(FEED_SYMBOL,),          # gold carries btc_state = null
        readvancing_fade=guards._is_readvancing_fade,
    )


# ============================================
# CLI / RUN
# ============================================

def parse_args():
    p = argparse.ArgumentParser(description="Gold (XAUUSD) multi-strategy scanner")
    p.add_argument("-tf", "--timeframe", default=config.get_str("GOLD_TIMEFRAME", "15m"),
                   help="1m 5m 15m 30m 1h 2h 4h 6h 12h 1d (default: 15m; .env GOLD_TIMEFRAME)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--account-size", type=float, default=config.get_float("ACCOUNT_SIZE", 10000))
    p.add_argument("--risk", type=float, default=config.get_float("RISK", 0.01),
                   help="risk per trade (default 0.01 = 1%%, per hmm.md's 1%% rule)")
    p.add_argument("--min-conf", type=float, default=None, help=f"override GOLD_MIN_CONF ({MIN_CONF})")
    p.add_argument("--no-cloud", action="store_true", help="disable EMA cloud pullback (S1)")
    p.add_argument("--no-breakout", action="store_true", help="disable Asian range breakout (S2)")
    p.add_argument("--no-rsi2", action="store_true", help="disable Connors RSI(2) (S3)")
    p.add_argument("--no-session-filter", action="store_true", help="ignore dead/quiet hour gates")
    p.add_argument("--loop", type=int, default=config.get_int("GOLD_LOOP", 0),
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
                 use_cloud=not args.no_cloud,
                 use_breakout=not args.no_breakout,
                 use_rsi2=not args.no_rsi2,
                 use_session=not args.no_session_filter)
            health.report_ok("gold-scanner")
        except Exception as e:
            print(f"❌ scan failed: {str(e)[:100]}")
            health.report_error("gold-scanner", e)
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
