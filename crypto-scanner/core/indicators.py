"""Shared indicator library — the Nadaraya-Watson mean-reversion suite.

Pure functions (numpy only, no I/O, no module state) used by the mean-reversion
scanners (scanner.py, metals-scanner.py). These were byte-for-byte identical copies
in both files; they now live here so a fix lands once.

NOTE: xau-scanner.py deliberately does NOT use these — it is a momentum strategy
with its own indicator set (Awesome Oscillator, Bears Power, MACD, CCI, and its own
rsi/ema/sma). Keep it that way; do not route it through this module.
"""
import numpy as np


def gaussian_kernel(x, h):
    return np.exp(-(x**2) / (2 * h**2))


def nadaraya_watson_envelope(price, h, mult, lookback):
    n = len(price)
    if n < lookback:
        return None, None, None

    price_array = np.array(price[-lookback:])
    smoothed = np.zeros(lookback)
    for i in range(lookback):
        w = gaussian_kernel(np.arange(lookback) - i, h)
        smoothed[i] = np.sum(price_array * w) / np.sum(w)

    mae = np.mean(np.abs(price_array - smoothed)) * mult
    middle = smoothed[-1]
    upper = middle + mae
    lower = middle - mae

    return middle, upper, lower


def rsi(price, period=14):
    """
    Wilder's RSI with proper recursive smoothing.
    Fix #1: added Wilder's smoothing loop (was only averaging first `period` bars).
    Fix #2: use np.zeros_like instead of delta.copy() * 0.
    """
    if len(price) < period + 1:
        return 50.0

    delta = np.diff(price)
    # Fix #2 — clean initialisation
    gain = np.zeros_like(delta)
    loss = np.zeros_like(delta)
    gain[delta > 0] = delta[delta > 0]
    loss[delta < 0] = -delta[delta < 0]

    # Seed with simple average of first `period` bars
    avg_gain = np.mean(gain[:period])
    avg_loss = np.mean(loss[:period])

    # Fix #1 — Wilder's smoothing for remaining bars
    for i in range(period, len(delta)):
        avg_gain = (avg_gain * (period - 1) + gain[i]) / period
        avg_loss = (avg_loss * (period - 1) + loss[i]) / period

    if avg_loss == 0:
        return 100.0
    if avg_gain == 0:
        return 0.0

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


# ============================================
# SQUEEZE MOMENTUM INDICATOR
# ============================================

def squeeze_momentum(high, low, close, bb_period=20, bb_mult=2, kc_period=20, kc_mult=1.5):
    """
    Calculates Squeeze Momentum (LazyBear style)
    Returns: (squeeze_on, momentum_value, squeeze_release)
    """
    # Bollinger Bands
    sma = np.mean(close[-bb_period:])
    std = np.std(close[-bb_period:])
    bb_upper = sma + (bb_mult * std)
    bb_lower = sma - (bb_mult * std)

    # Keltner Channels
    tr = np.zeros(len(close))
    for i in range(1, len(close)):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
    atr = np.mean(tr[-kc_period:])
    kc_upper = sma + (kc_mult * atr)
    kc_lower = sma - (kc_mult * atr)

    # Squeeze condition: BB inside KC
    squeeze_on = (bb_upper < kc_upper) and (bb_lower > kc_lower)

    # Momentum: price relative to bands
    if len(close) > 20:
        momentum = ((close[-1] - sma) / (sma * 0.01)) * 0.5
    else:
        momentum = 0

    # Fix #4 — squeeze_release detects a price breakout through the KC boundary
    # (the old code required squeeze_on=True simultaneously, which is self-contradicting:
    # a release means the squeeze just ENDED, not that it is still active).
    squeeze_release = False
    if len(close) > 2:
        # Upside breakout: current bar closes above KC upper; previous bar did not
        if close[-1] > kc_upper and close[-2] <= kc_upper:
            squeeze_release = True
        # Downside breakout: current bar closes below KC lower; previous bar did not
        elif close[-1] < kc_lower and close[-2] >= kc_lower:
            squeeze_release = True

    return squeeze_on, momentum, squeeze_release


# ============================================
# STATISTICAL MEAN-REVERSION ENGINE (SMRE)
# ============================================

def smre_filter(price, window=50, threshold=2.0):
    if len(price) < window:
        return False, 0, 0

    mean_val = np.mean(price[-window:])
    std_val = np.std(price[-window:])

    if std_val == 0:
        return False, 0, 0

    z_score = (price[-1] - mean_val) / std_val
    confidence = min(100, abs(z_score) / threshold * 100)
    is_mean_reverting = abs(z_score) > threshold

    return is_mean_reverting, z_score, confidence


def stationarity_test(price, window=100):
    """
    Estimate Hurst exponent via variance scaling of log returns.
    Fix #3: old formula (0.5 * var2/var1) was not a valid Hurst estimator.
    Correct approach: H = 0.5 * log2(var_full / var_half), clamped to [0, 1].
    H < 0.5  → mean-reverting (stationary-like)
    H ≈ 0.5  → random walk
    H > 0.5  → trending
    """
    if len(price) < window:
        return False, 0.5

    log_returns = np.diff(np.log(price[-window:]))
    if len(log_returns) < 4:
        return False, 0.5

    var_full = np.var(log_returns)
    half = len(log_returns) // 2
    var_half = np.var(log_returns[:half])

    if var_full > 0 and var_half > 0:
        # Fix #3 — variance-scaling Hurst estimate
        hurst = 0.5 * np.log(var_full / var_half) / np.log(2)
        hurst = max(0.0, min(1.0, hurst))
    else:
        hurst = 0.5

    is_stationary = hurst < 0.5
    return is_stationary, round(hurst, 2)


def volatility_regime(price, window=50):
    if len(price) < window:
        return 'medium', 50

    returns = np.diff(price[-window:])
    if len(returns) < 2:
        return 'medium', 50

    current_vol = np.std(returns)
    avg_vol = np.std(np.diff(price[-window*2:])) if len(price) > window*2 else current_vol

    if avg_vol == 0:
        return 'medium', 50

    vol_ratio = current_vol / avg_vol
    vol_score = min(100, vol_ratio * 50)

    if vol_ratio < 0.7:
        regime = 'low'
    elif vol_ratio < 1.3:
        regime = 'medium'
    else:
        regime = 'high'

    return regime, round(vol_score, 1)


# ============================================
# SMART MONEY CONCEPTS (SMC) FUNCTIONS
# ============================================

def detect_market_structure(high, low, close, swing_size=10):
    """
    Detect Break of Structure (BOS) and Change of Character (CHoCH)
    Returns: (structure_type, trend_direction, swing_high, swing_low)
    """
    if len(high) < swing_size * 2:
        return 'neutral', 'neutral', None, None

    # Find swing highs and lows
    swing_highs = []
    swing_lows = []

    for i in range(swing_size, len(high) - swing_size):
        # Swing high
        if high[i] == max(high[i-swing_size:i+swing_size]):
            swing_highs.append((i, high[i]))
        # Swing low
        if low[i] == min(low[i-swing_size:i+swing_size]):
            swing_lows.append((i, low[i]))

    if len(swing_highs) < 2 or len(swing_lows) < 2:
        return 'neutral', 'neutral', None, None

    # Check for Break of Structure
    last_high = swing_highs[-1][1]
    prev_high = swing_highs[-2][1]
    last_low = swing_lows[-1][1]
    prev_low = swing_lows[-2][1]

    # Uptrend: higher highs and higher lows
    if last_high > prev_high and last_low > prev_low:
        structure = 'bos_up'
        trend = 'bullish'
    # Downtrend: lower highs and lower lows
    elif last_high < prev_high and last_low < prev_low:
        structure = 'bos_down'
        trend = 'bearish'
    # Change of Character: break of previous structure
    elif last_high > prev_high and last_low < prev_low:
        structure = 'choch'
        trend = 'neutral'
    else:
        structure = 'neutral'
        trend = 'neutral'

    return structure, trend, swing_highs[-1][1], swing_lows[-1][1]


def find_order_block(high, low, close, lookback=50):
    """
    Identify Order Blocks (OB) - the last opposing candle before a strong move
    Returns: (ob_high, ob_low, ob_direction)
    """
    if len(high) < lookback or len(close) < lookback:
        return None, None, None

    # Look for the last strong impulsive move
    for i in range(len(high)-1, max(0, len(high)-lookback), -1):
        try:
            price_change = abs(close[i] - close[i-1])
            avg_change = np.mean(np.abs(np.diff(close[-lookback:])))

            # Strong move (2x average)
            if price_change > avg_change * 2:
                # Bullish OB: last bearish candle before move
                if close[i] > close[i-1]:
                    ob_high = float(high[i-1])
                    ob_low = float(low[i-1])
                    ob_direction = 'bullish'
                    return ob_high, ob_low, ob_direction
                # Bearish OB: last bullish candle before move
                else:
                    ob_high = float(high[i-1])
                    ob_low = float(low[i-1])
                    ob_direction = 'bearish'
                    return ob_high, ob_low, ob_direction
        except (IndexError, TypeError, ValueError):
            continue

    return None, None, None


def find_fair_value_gap(high, low, lookback=50):
    """
    Identify Fair Value Gaps (FVG)
    Returns: (fvg_high, fvg_low, fvg_direction)
    """
    if len(high) < 3 or len(low) < 3:
        return None, None, None

    # Look for 3-candle pattern: gap between candle 1 and candle 3
    for i in range(len(high)-3, max(0, len(high)-lookback), -1):
        try:
            # Bullish FVG: high of candle 1 < low of candle 3
            if high[i] < low[i+2]:
                fvg_high = float(low[i+2])
                fvg_low = float(high[i])
                fvg_direction = 'bullish'
                return fvg_high, fvg_low, fvg_direction
            # Bearish FVG: low of candle 1 > high of candle 3
            elif low[i] > high[i+2]:
                fvg_high = float(low[i])
                fvg_low = float(high[i+2])
                fvg_direction = 'bearish'
                return fvg_high, fvg_low, fvg_direction
        except (IndexError, TypeError, ValueError):
            continue

    return None, None, None
