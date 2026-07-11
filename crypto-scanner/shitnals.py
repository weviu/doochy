#!/usr/bin/env python3
"""
shitnals — Gold (XAUUSD) inverse-signal scanner — cTrader feed → data/alerts.json.

The premise, taken seriously: hunt for signals so reliably WRONG that fading them
is an edge. Each scan detects what a losing retail trader would do on the last
closed 1h bar (the "shitnal"), then publishes the EXACT OPPOSITE trade to the
feed: opposite direction at the same entry, with the shitnal's SL and TP levels
SWAPPED (shitnal BUY @4100 sl 4080 tp 4120 → published SELL @4100 sl 4120
tp 4080). Since the shitnal carries house geometry (stop 1.5×ATR / TP 2.0×ATR),
the published trade runs stop 2.0×ATR / TP 1.5×ATR — a 0.75:1 R:R whose
breakeven is 57% wins. Inversion happens HERE, before the feed write: the feed
entry is always the tradeable side, doochybot executes it as-is with no
inversion logic of its own, and the raw shitnal never leaves the console log.

Inversion is NOT free money by default, and most of the basket tested (2026-07-11,
walk-forward, cost-adjusted, SL-first on same-bar, $0.35/oz RT) proved it: a
strategy that loses to costs/chop loses in BOTH directions. What ships is only
what was robustly wrong-for-a-directional-reason, i.e. its inverse cleared every
house robustness check on the side we actually trade:

  W1  BREAKOUT FADE (the shitnal)  →  publish the breakout WITH the trend
      Shitnal: fade the first 1h close beyond the prior-60-bar extreme when the
      1h EMA34/134 cloud backs the breakout ("it's gone too far, it must revert").
      Raw: -0.218 avgR (n=438, 35% win) — negative across the ENTIRE donchian
      lb40..100 × stop × TP grid. Published mirror (stop 2.0×ATR / TP 1.5×ATR):
      +0.120 avgR, n=438, 65% win (vs 57% breakeven), BUY +0.131 / SELL +0.088,
      regime-thirds +0.04/+0.11/+0.21, halves +0.113/+0.127, every calendar year
      positive (2024 +0.04, 2025 +0.14, 2026 +0.22). All 54 sweep cells positive
      (the un-mirrored 1.5/2.0 variant scores +0.150 — the mirror gives up a
      little expectancy for a much higher hit rate).
      CAVEAT: the SELL side is thin (n=113) and its subsample profit is
      2026-heavy (2024/25 shorts ≈ -0.09/-0.05); the BUY side is positive every year.

  W2  KNIFE CATCH (the shitnal)  →  publish with-trend continuation
      Shitnal: RSI(2) crossing into an extreme AGAINST the SMA200 side — buying
      a crash below trend / shorting a squeeze above it ("it can't go lower").
      Wrongest at the wildest extremes: levels 5/95 (raw -0.181 avgR, n=617);
      milder 15/85 knife-catches are only cost-level bad — not invertible.
      Published mirror (stop 2.0×ATR / TP 1.5×ATR): +0.089 avgR, n=617, 63% win,
      BUY +0.092 / SELL +0.083, thirds +0.05/+0.12/+0.09, halves +0.095/+0.082,
      every calendar year positive (2024 +0.05, 2025 +0.15, 2026 +0.04). Whole
      level×geometry grid positive.
      CAVEAT: the profitable direction rotates by year (2025 shorts negative,
      2026 longs negative) even though every year nets positive.

  Both are 1h-sourced regardless of scan cadence; ~172/524 W1 triggers land on a
  W2 bar with the same direction, handled as confluence via core/trend.combine.
  Sample bias, stated out loud: gold trended strongly higher over the 2.4-year
  window — the inverse edges lean long-heavy, and a regime flip is the real risk.

REJECTED as not invertible (raw loss ≈ cost drag, inverse also negative — do not
re-add without new evidence). Tested on XAU/XAG/US100/BTC/ETH, 1h and 15m:
  – big-bar chase (k=1.5..2.5×ATR bodies): inverse negative nearly everywhere;
  – streak chase (4/5/6 consecutive closes): both sides negative on all assets;
  – overbought/oversold RSI14-cross chase: RAW is *positive* on gold 15m (+0.25)
    — buying gold strength is momentum, not a sin — so the inverse loses;
  – quiet-hour (23-05 UTC) breakout chase: raw positive on gold/US100 — not a sin;
  – laggy EMA20/50 cross: ~flat both ways everywhere (pure cost bleed);
  – EVERYTHING on silver (both sides negative across the whole basket);
  – EVERYTHING on BTC/ETH 15m (raw -0.2..-0.4 AND inverse -0.2..-0.5: fees+chop
    eat both sides; there is no invertible wrongness in crypto at this geometry);
  – W1/W2 on gold 15m: inverse fades to ≈0 net of costs (1h only).

  GATES (house-standard; conf-level only — the backtested trigger is untouched)
      • 4h EMA34/134 cloud: soft align-bonus / oppose-penalty (not backtested,
        soft by design — a hard gate would strip the validated 1h subset).
      • Dead hours 21-22 UTC (COMEX settle) → no entries; quiet Asia → -conf.
      • Whipsaw guard (plain contra-flip cooldown) + feed no-re-arm guard.
      • src_bar feed dedupe (the closed 1h bar) — a 15m loop re-reads the same
        1h bar; without src_bar it would re-fire at drifting prices.

Usage:
    python shitnals.py                 # single 1h-sourced scan
    python shitnals.py -v --loop 15    # resident, rescan every 15 min
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
from core.trend import ema, sma, atr as _atr, wilder_rsi as rsi, cloud_direction
from core import trend as _trend

# ============================================
# CONFIG (.env-tunable; SHIT_* prefix)
# ============================================
CTRADER_SYMBOL = "XAUUSD"
FEED_SYMBOL = "XAUUSD"
SIGNAL_SOURCE = "shitnals"
FEED_PATH = "./data/alerts.json"
PX_DECIMALS = 2

# 1h bars fetched per scan. EMA134 is history-sensitive (ewm warmup): 600 bars
# leaves <0.2% residual weight vs the full-history EMA the backtest used.
LOOKBACK = config.get_int("SHIT_LOOKBACK", 600)
ATR_WINDOW = config.get_int("SHIT_ATR_WINDOW", 14)
SOURCE_TIMEFRAME = config.get_str("SHIT_SOURCE_TIMEFRAME", "1h")

CLOUD_FAST = config.get_int("SHIT_CLOUD_FAST", 34)
CLOUD_SLOW = config.get_int("SHIT_CLOUD_SLOW", 134)

# --- W1: breakout fade → published as its mirror ---
# STOP/TP describe the SHITNAL's geometry; the published trade swaps them
# (published stop = W1_TP_ATR, published TP = W1_STOP_ATR — the backtested mirror).
DONCHIAN_LB = config.get_int("SHIT_DONCHIAN_LB", 60)      # positive plateau lb40..100
W1_STOP_ATR = config.get_float("SHIT_W1_STOP_ATR", 1.5)
W1_TP_ATR = config.get_float("SHIT_W1_TP_ATR", 2.0)
CONF_W1 = config.get_float("SHIT_CONF_W1", 62.0)

# --- W2: knife catch → published as its mirror (same swap as W1) ---
RSI2_BUY_LVL = config.get_float("SHIT_RSI2_BUY", 5.0)     # the WILDEST knife-catches
RSI2_SELL_LVL = config.get_float("SHIT_RSI2_SELL", 95.0)  # (5/95); 15/85 not invertible
RSI2_MA = config.get_int("SHIT_RSI2_MA", 200)
W2_STOP_ATR = config.get_float("SHIT_W2_STOP_ATR", 1.5)
W2_TP_ATR = config.get_float("SHIT_W2_TP_ATR", 2.0)
CONF_W2 = config.get_float("SHIT_CONF_W2", 58.0)

# --- HTF / confluence (soft conf adjustments only) ---
HTF_TIMEFRAME = config.get_str("SHIT_HTF_TIMEFRAME", "4h")
HTF_ALIGN_BONUS = config.get_float("SHIT_HTF_ALIGN_BONUS", 8.0)
HTF_OPPOSE_PENALTY = config.get_float("SHIT_HTF_OPPOSE_PENALTY", 12.0)
CONFLUENCE_BONUS = config.get_float("SHIT_CONFLUENCE_BONUS", 12.0)
MIN_CONF = config.get_float("SHIT_MIN_CONF", 55.0)
MAX_CONF = 95.0

# Session gate (same hours as the gold siblings — COMEX settle + thin Asia).
DEAD_HOURS_UTC = set(config.get_list("SHIT_DEAD_HOURS_UTC", ["21", "22"]))
QUIET_HOURS_UTC = set(config.get_list("SHIT_QUIET_HOURS_UTC", ["23", "0", "1", "2", "3", "4", "5"]))
QUIET_PENALTY = config.get_float("SHIT_QUIET_PENALTY", 10.0)

WHIPSAW_GUARD = config.get_bool("SHIT_WHIPSAW_GUARD", True)
CONTRA_COOLDOWN_MIN = config.get_int("SHIT_CONTRA_COOLDOWN_MIN", 120)  # 2h on a 1h source


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
    """Feed dedupe tag: UTC timestamp of the last CLOSED 1h bar the shitnal was
    read from (a 15m loop re-reads the same 1h bar until it rolls)."""
    return datetime.fromtimestamp(int(df["timestamp"].iloc[-1]) // 1000,
                                  tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


_INV = {"BUY": "SELL", "SELL": "BUY"}


# ============================================
# SHITNAL DETECTORS  (read the last CLOSED 1h bar; each returns the INVERTED,
# publishable signal — `shitnal` in the dict is the raw wrong side, for the log)
# ============================================

def w1_breakout_fade(df, price):
    """Shitnal: fade the first close beyond the prior-60-bar extreme when the 1h
    cloud backs the breakout. Published: join the breakout (the inverse).

    First-close semantics (previous bar still inside its own prior window) stop a
    persistent breakout from re-arming every bar — same trigger the backtest used.
    """
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    if len(c) < CLOUD_SLOW + DONCHIAN_LB + 5:
        return None
    atr_now = atr(h, l, c)[-1]
    if not atr_now or np.isnan(atr_now):
        return None
    trend = cloud_direction(c, CLOUD_FAST, CLOUD_SLOW)

    prior_hi = h[-1 - DONCHIAN_LB:-1].max()
    prior_lo = l[-1 - DONCHIAN_LB:-1].min()
    prev_prior_hi = h[-2 - DONCHIAN_LB:-2].max()
    prev_prior_lo = l[-2 - DONCHIAN_LB:-2].min()

    shit_dir, level = None, None
    if c[-1] > prior_hi and c[-2] <= prev_prior_hi and trend == "BUY":
        shit_dir, level = "SELL", prior_hi      # retail fades the upside breakout
    elif c[-1] < prior_lo and c[-2] >= prev_prior_lo and trend == "SELL":
        shit_dir, level = "BUY", prior_lo       # retail buys the downside break
    if shit_dir is None:
        return None

    direction = _INV[shit_dir]
    # literal mirror: the shitnal's TP level becomes the published SL, and the
    # shitnal's SL level becomes the published TP (stop 2.0×ATR / TP 1.5×ATR)
    if direction == "BUY":      # shitnal SELL had tp below / sl above the entry
        stop, tp = price - W1_TP_ATR * atr_now, price + W1_STOP_ATR * atr_now
    else:                       # shitnal BUY had sl below / tp above the entry
        stop, tp = price + W1_TP_ATR * atr_now, price - W1_STOP_ATR * atr_now
    return {"strategy": "inv_breakout_fade", "direction": direction, "conf": CONF_W1,
            "stop": stop, "tp": tp, "src_bar": _src_bar(df), "shitnal": shit_dir,
            "note": f"shitnal: {shit_dir} (fade the {DONCHIAN_LB}-bar breakout "
                    f"{'above' if shit_dir == 'SELL' else 'below'} {level:.2f}, cloud "
                    f"{'green' if trend == 'BUY' else 'red'}) → published {direction}"}


def w2_knife_catch(df, price):
    """Shitnal: RSI(2) crossing into a wild extreme (<5 / >95) AGAINST the SMA200
    side — the knife-catch. Published: with-trend continuation (the inverse)."""
    c = df["close"].values
    if len(c) < RSI2_MA + 5:
        return None
    atr_now = atr(df["high"].values, df["low"].values, c)[-1]
    if not atr_now or np.isnan(atr_now):
        return None
    ma = sma(c, RSI2_MA)[-1]
    r2 = rsi(c, 2)

    shit_dir = None
    if c[-1] < ma and r2[-1] < RSI2_BUY_LVL and r2[-2] >= RSI2_BUY_LVL:
        shit_dir = "BUY"        # retail buys the crash below trend
    elif c[-1] > ma and r2[-1] > RSI2_SELL_LVL and r2[-2] <= RSI2_SELL_LVL:
        shit_dir = "SELL"       # retail shorts the squeeze above trend
    if shit_dir is None:
        return None

    direction = _INV[shit_dir]
    # same literal mirror as W1: published SL = shitnal TP, published TP = shitnal SL
    if direction == "BUY":
        stop, tp = price - W2_TP_ATR * atr_now, price + W2_STOP_ATR * atr_now
    else:
        stop, tp = price + W2_TP_ATR * atr_now, price - W2_STOP_ATR * atr_now
    return {"strategy": "inv_knife_catch", "direction": direction, "conf": CONF_W2,
            "stop": stop, "tp": tp, "src_bar": _src_bar(df), "shitnal": shit_dir,
            "note": f"shitnal: {shit_dir} (knife-catch, RSI(2)={r2[-1]:.1f} "
                    f"{'below' if shit_dir == 'BUY' else 'above'} SMA{RSI2_MA} {ma:.2f}) "
                    f"→ published {direction}"}


# ============================================
# HTF TREND (4h EMA cloud — soft conf adjust only)
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
    try:
        with open(feed_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def scan(verbose, account_size, risk_percent, use_w1=True, use_w2=True,
         use_session=True, feed_path=FEED_PATH):
    now = datetime.now(timezone.utc)
    print(f"\n{'='*100}")
    print(f"💩 SHITNALS (cTrader {CTRADER_SYMBOL}): {SOURCE_TIMEFRAME}-sourced | "
          f"{now.strftime('%Y-%m-%d %H:%M UTC')} | feed carries the INVERSE of every shitnal")
    print(f"   Detectors: breakout_fade={'✅' if use_w1 else '❌'} "
          f"knife_catch={'✅' if use_w2 else '❌'} | session gate={'✅' if use_session else '❌'}")
    print(f"{'='*100}")

    if use_session and str(now.hour) in DEAD_HOURS_UTC:
        print(f"🌙 Dead hour ({now.hour}:00 UTC — COMEX settle/close). No entries taken.")
        return

    df = _closed_bars(SOURCE_TIMEFRAME, LOOKBACK)
    if df is None or len(df) < max(CLOUD_SLOW + DONCHIAN_LB, RSI2_MA) + 5:
        print(f"❌ insufficient data ({0 if df is None else len(df)} bars)")
        return

    close = df["close"].values
    price = float(close[-1])  # loop runs right after bar close; entry anchor = live close
    atr_now = atr(df["high"].values, df["low"].values, close)[-1]
    rsi14 = float(rsi(close, 14)[-1])

    candidates = []
    if use_w1:
        candidates.append(w1_breakout_fade(df, price))
    if use_w2:
        candidates.append(w2_knife_catch(df, price))
    candidates = [c for c in candidates if c]

    if verbose:
        e34, e134 = ema(close, CLOUD_FAST)[-1], ema(close, CLOUD_SLOW)[-1]
        print(f"   price={price:.2f}  ATR({ATR_WINDOW})={atr_now:.2f}  RSI14={rsi14:.1f}  "
              f"RSI2={rsi(close, 2)[-1]:.1f}  1h-cloud={'green' if e34 > e134 else 'red'}")

    if not candidates:
        print("📭 No shitnals on this scan — nobody is doing anything stupid enough yet.")
        return

    htf = htf_trend()
    best, conf = _trend.combine(
        candidates, htf,
        confluence_bonus=CONFLUENCE_BONUS, htf_align_bonus=HTF_ALIGN_BONUS,
        htf_oppose_penalty=HTF_OPPOSE_PENALTY, max_conf=MAX_CONF,
    )
    if best == "conflict":
        # can't happen from one bar's W1+W2 (both invert the same wrong side),
        # but keep the house stand-aside for safety
        print("⚖️  Conflicting inverted directions — standing aside:")
        for c in candidates:
            print(f"   {c['direction']:<4} {c['strategy']}: {c['note']}")
        return

    if use_session and str(now.hour) in QUIET_HOURS_UTC:
        conf -= QUIET_PENALTY
        conf = min(conf, MAX_CONF)

    if WHIPSAW_GUARD:
        blocked, why = guards.gold_whipsaw_block(
            best["direction"], _load_feed(feed_path), now,
            cooldown_min=CONTRA_COOLDOWN_MIN, session_cooldown_min=CONTRA_COOLDOWN_MIN,
            session_window_min=0,               # no session-open refinement on a 1h source
            symbol=FEED_SYMBOL, signal_source=SIGNAL_SOURCE)
        if blocked:
            print(f"🔁 Whipsaw guard — standing aside: {why}")
            return

    print(f"\n💩 shitnal detected: {best['shitnal']} — publishing the opposite.")
    print(f"🎯 {best['direction']} {FEED_SYMBOL} @ ${price:.2f}  (confidence {conf:.0f}%)")
    print(f"   strategy: {best['strategy']}"
          + (f"  +confluence: {', '.join(c['strategy'] for c in candidates if c is not best)}"
             if len(candidates) > 1 else ""))
    print(f"   {best['note']}")
    print(f"   HTF({HTF_TIMEFRAME}) trend: {htf or 'n/a'}"
          f" ({'aligned ✅' if htf == best['direction'] else 'opposed ⚠️' if htf else '—'})")
    risk = abs(price - best["stop"])
    reward = abs(best["tp"] - price)
    if risk:
        print(f"   🛑 SL ${best['stop']:.2f}  🎯 TP ${best['tp']:.2f}  "
              f"(risk ${risk:.2f} / reward ${reward:.2f} → R:R {reward/risk:.2f})")
    pos = calculate_position_size(price, best["stop"], conf, account_size, risk_percent)
    print(f"   📊 size {pos['size']:.4f} oz (${pos['value']:.2f}) | risk ${pos['risk_amount']:.2f} "
          f"({pos['risk_percent']:.2f}% of account)")

    if conf < MIN_CONF:
        print(f"\n🚫 Confidence {conf:.0f}% < minimum {MIN_CONF:.0f}% — not written to feed.")
        return

    signal = {
        "symbol": FEED_SYMBOL,
        "signal_type": best["direction"],   # ALWAYS the inverted (tradeable) side
        "confidence": conf,
        "rsi": round(rsi14, 2),
        "price": price,
        "stop_loss": round(best["stop"], PX_DECIMALS),
        "tp1": round(best["tp"], PX_DECIMALS),
        "time_exit_min": None,
        "src_bar": best.get("src_bar"),
    }
    _core_write_to_feed(
        [signal], SOURCE_TIMEFRAME,
        signal_source=SIGNAL_SOURCE,
        btc_state=None,
        feed_path=feed_path,
        futures_symbols=(FEED_SYMBOL,),     # gold carries btc_state = null
        readvancing_fade=guards._is_readvancing_fade,
    )


# ============================================
# CLI / RUN
# ============================================

def parse_args():
    p = argparse.ArgumentParser(
        description="shitnals — gold inverse-signal scanner (publishes the opposite of "
                    "reliably-wrong retail setups)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--account-size", type=float, default=config.get_float("ACCOUNT_SIZE", 10000))
    p.add_argument("--risk", type=float, default=config.get_float("RISK", 0.01),
                   help="risk per trade (default 0.01 = 1%%)")
    p.add_argument("--min-conf", type=float, default=None, help=f"override SHIT_MIN_CONF ({MIN_CONF})")
    p.add_argument("--no-w1", action="store_true", help="disable inverse breakout-fade (W1)")
    p.add_argument("--no-w2", action="store_true", help="disable inverse knife-catch (W2)")
    p.add_argument("--no-session-filter", action="store_true", help="ignore dead/quiet hour gates")
    p.add_argument("--loop", type=int, default=config.get_int("SHIT_LOOP", 0),
                   help="rescan every N minutes, clock-aligned (0 = single run)")
    return p.parse_args()


def main():
    global MIN_CONF
    args = parse_args()
    if args.min_conf is not None:
        MIN_CONF = args.min_conf

    def _run_once():
        t0 = time.time()
        try:
            scan(args.verbose, args.account_size, args.risk,
                 use_w1=not args.no_w1,
                 use_w2=not args.no_w2,
                 use_session=not args.no_session_filter)
            health.report_ok("shitnals")
        except Exception as e:
            print(f"❌ scan failed: {str(e)[:100]}")
            health.report_error("shitnals", e)
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
