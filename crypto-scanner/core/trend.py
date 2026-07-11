"""Shared trend-following strategy kit — used by gold-scanner.py and trend-scanner.py.

Two with-trend setups (deliberately the opposite regime coverage from the
mean-reversion NW-envelope scanners, which fade every move):

  cloud_pullback  — docs/hmm.md: EMA fast/slow cloud defines the trend; with price
                    and both ribbon EMAs on the trend side, entry is the ribbon
                    resume-cross ending a pullback. Stop beyond the cloud, TP at
                    a fixed R multiple.
  rsi2_pullback   — Connors RSI(2): with-trend dip fade against a long-SMA filter.
                    Volatility-spike guard (core/guards) penalises it during range
                    explosions, where snap-backs are least reliable.

Pure functions — NO config reads here. Each scanner passes its own tuned values so
per-scanner .env prefixes (GOLD_*, TREND_*) stay in the drivers.
"""
import numpy as np
import pandas as pd

from core import guards


# ============================================
# INDICATORS
# ============================================

def ema(arr, period):
    return pd.Series(arr).ewm(span=period, adjust=False).mean().values


def sma(arr, period):
    return pd.Series(arr).rolling(period).mean().values


def atr(high, low, close, period=14):
    h, l, c = pd.Series(high), pd.Series(low), pd.Series(close)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean().values


def wilder_rsi(close, period):
    """Wilder RSI (matches the classic Connors RSI(2) definition at period=2)."""
    delta = pd.Series(close).diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50).values


def cloud_direction(close, fast=34, slow=134):
    """'BUY' when the EMA cloud is green (fast>slow), else 'SELL'. None if short."""
    if len(close) < slow + 5:
        return None
    return "BUY" if ema(close, fast)[-1] > ema(close, slow)[-1] else "SELL"


# ============================================
# STRATEGIES — each returns a signal dict or None
# ============================================

def cloud_pullback(df, atr_now, *, cloud_fast=34, cloud_slow=134,
                   ribbon_fast=5, ribbon_slow=8, rr=2.0, stop_atr_buf=0.25,
                   conf=65.0):
    """docs/hmm.md: EMA cloud trend + ribbon pullback-resume cross on the last bar."""
    close = df["close"].values
    fast_c, slow_c = ema(close, cloud_fast), ema(close, cloud_slow)
    e_fast, e_slow = ema(close, ribbon_fast), ema(close, ribbon_slow)
    cloud_top = max(fast_c[-1], slow_c[-1])
    cloud_bot = min(fast_c[-1], slow_c[-1])
    price = close[-1]

    bull_cloud = fast_c[-1] > slow_c[-1]
    cross_up = e_fast[-1] > e_slow[-1] and e_fast[-2] <= e_slow[-2]
    cross_dn = e_fast[-1] < e_slow[-1] and e_fast[-2] >= e_slow[-2]

    if bull_cloud and cross_up and min(price, e_fast[-1], e_slow[-1]) > cloud_top:
        stop = cloud_bot - stop_atr_buf * atr_now
        risk = price - stop
        if risk <= 0:
            return None
        return {"strategy": "cloud_pullback", "direction": "BUY", "conf": conf,
                "stop": stop, "tp": price + rr * risk,
                "note": f"cloud green, EMA{ribbon_fast}/{ribbon_slow} resume-cross above cloud "
                        f"({cloud_bot:.2f}-{cloud_top:.2f})"}
    if not bull_cloud and cross_dn and max(price, e_fast[-1], e_slow[-1]) < cloud_bot:
        stop = cloud_top + stop_atr_buf * atr_now
        risk = stop - price
        if risk <= 0:
            return None
        return {"strategy": "cloud_pullback", "direction": "SELL", "conf": conf,
                "stop": stop, "tp": price - rr * risk,
                "note": f"cloud red, EMA{ribbon_fast}/{ribbon_slow} resume-cross below cloud "
                        f"({cloud_bot:.2f}-{cloud_top:.2f})"}
    return None


def rsi2_pullback(df, atr_now, *, buy_level=10.0, sell_level=90.0, trend_ma=200,
                  stop_atr=2.5, tp_atr=1.25, conf=58.0):
    """Connors RSI(2): with-trend dip fade against the SMA trend filter."""
    close = df["close"].values
    if len(close) < trend_ma + 5:
        return None
    ma = sma(close, trend_ma)[-1]
    r2 = wilder_rsi(close, 2)
    price = close[-1]

    # freshness: RSI(2) crossed INTO the extreme on this bar (no repeat-firing all
    # the way down a slide)
    buy_trig = r2[-1] < buy_level and r2[-2] >= buy_level
    sell_trig = r2[-1] > sell_level and r2[-2] <= sell_level

    sig = None
    if price > ma and buy_trig:
        sig = {"strategy": "rsi2_pullback", "direction": "BUY", "conf": conf,
               "stop": price - stop_atr * atr_now, "tp": price + tp_atr * atr_now,
               "note": f"RSI(2)={r2[-1]:.1f} dip above SMA{trend_ma} ({ma:.2f})"}
    elif price < ma and sell_trig:
        sig = {"strategy": "rsi2_pullback", "direction": "SELL", "conf": conf,
               "stop": price + stop_atr * atr_now, "tp": price - tp_atr * atr_now,
               "note": f"RSI(2)={r2[-1]:.1f} spike below SMA{trend_ma} ({ma:.2f})"}
    if sig is None:
        return None

    # it's a fade (with-trend, but still a dip-buy): penalise when the current bar
    # is a volatility explosion
    spike = guards.volatility_spike_atr(df["high"].values, df["low"].values, close)
    if spike > guards.VOL_SPIKE_PENALTY_ATR:
        pen = (spike - guards.VOL_SPIKE_PENALTY_ATR) * guards.VOL_SPIKE_PENALTY_PER_ATR
        sig["conf"] -= pen
        sig["note"] += f" | vol-spike {spike:.1f}×ATR (−{pen:.0f} conf)"
    return sig


# ============================================
# CONFLUENCE
# ============================================

def combine(candidates, htf_dir, *, confluence_bonus=12.0, htf_align_bonus=8.0,
            htf_oppose_penalty=12.0, max_conf=95.0):
    """Combine per-symbol strategy candidates into one signal.

    Returns (best, conf):
      best=None, conf=None            — no candidates
      best='conflict', conf=None      — strategies disagree on direction → stand aside
      best=dict, conf=float           — the highest-conviction setup, confluence- and
                                        HTF-adjusted confidence
    """
    candidates = [c for c in candidates if c]
    if not candidates:
        return None, None
    if len({c["direction"] for c in candidates}) > 1:
        return "conflict", None

    best = max(candidates, key=lambda c: c["conf"])
    conf = best["conf"] + confluence_bonus * (len(candidates) - 1)
    if htf_dir == best["direction"]:
        conf += htf_align_bonus
    elif htf_dir is not None:
        conf -= htf_oppose_penalty
    return best, min(conf, max_conf)
