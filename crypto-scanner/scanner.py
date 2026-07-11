#!/usr/bin/env python3
"""
Multi-Asset Scanner with Nadaraya-Watson Envelope
Supports both long-term and short-term timeframes via command-line arguments
Includes Squeeze Momentum, SMRE, and Smart Money Concepts (SMC) filters

Usage:
    python scanner.py                    # Default: 1h timeframe
    python scanner.py -tf 15m            # 15-minute timeframe
    python scanner.py -tf 5m             # 5-minute timeframe
    python scanner.py -tf 4h             # 4-hour timeframe
    python scanner.py -tf 1h -v          # 1h with verbose output
    python scanner.py --help             # Show help

SMC Note:
    Smart Money Concepts (BOS, CHoCH, Order Blocks, FVGs) are implemented
    as built-in functions below. No external smc-toolkit dependency needed.
"""

import ccxt
import pandas as pd
import numpy as np
from datetime import datetime
import time
import warnings
import argparse
import sys
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from core.feed import write_to_feed as _core_write_to_feed
from core import config  # .env-backed settings (see core/config.py)
from core import guards  # shared anti-breakout guards + tunable constants (July-4 hardening)
from core import strategy  # shared strategy levels (ATR/TP constants)
from core.strategy import get_timeframe_params, calculate_position_size, calculate_entry_exit
warnings.filterwarnings('ignore')
    
# ============================================
# ARGUMENT PARSING
# ============================================

def parse_args():
    parser = argparse.ArgumentParser(
        description='Multi-Asset Scanner with Nadaraya-Watson Envelope',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scanner.py                    # Default: 1h timeframe
  python scanner.py -tf 15m            # 15-minute timeframe
  python scanner.py -tf 5m             # 5-minute timeframe (scalping)
  python scanner.py -tf 30m            # 30-minute timeframe
  python scanner.py -tf 4h             # 4-hour timeframe
  python scanner.py -tf 1h -v          # Verbose mode with all filters
  python scanner.py --list-timeframes  # Show all available timeframes
  python scanner.py --no-smc           # Disable Smart Money Concepts filter
        """
    )
    
    parser.add_argument(
        '-tf', '--timeframe',
        type=str,
        default=config.get_str("TIMEFRAME", "1h"),
        help='Timeframe to scan (default: 1h; .env TIMEFRAME). Options: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d'
    )
    
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Enable verbose output (shows all symbols, not just signals)'
    )
    
    parser.add_argument(
        '--list-timeframes',
        action='store_true',
        help='Show all available timeframes and exit'
    )
    
    parser.add_argument(
        '--account-size',
        type=float,
        default=config.get_float("ACCOUNT_SIZE", 10000),
        help='Account size in USD (default: 10000; .env ACCOUNT_SIZE)'
    )

    parser.add_argument(
        '--risk',
        type=float,
        default=config.get_float("RISK", 0.02),
        help='Risk per trade as percentage (default: 0.02 = 2%%; .env RISK)'
    )

    parser.add_argument(
        '--max-positions',
        type=int,
        default=config.get_int("MAX_POSITIONS", 3),
        help='Maximum concurrent positions (default: 3; .env MAX_POSITIONS)'
    )
    
    parser.add_argument(
        '--no-squeeze',
        action='store_true',
        help='Disable Squeeze Momentum filter'
    )
    
    parser.add_argument(
        '--no-smre',
        action='store_true',
        help='Disable Statistical Mean-Reversion Engine filter'
    )
    
    parser.add_argument(
        '--no-smc',
        action='store_true',
        help='Disable Smart Money Concepts filter'
    )

    parser.add_argument(
        '--loop',
        type=int,
        default=config.get_int("LOOP", 0),
        help='Repeat the scan every N minutes, keeping the process alive (0 = single run, default; .env LOOP)'
    )

    return parser.parse_args()

# ============================================
# CONFIGURATION
# ============================================

# Spot symbols (standard)
SPOT_SYMBOLS = [
    'BTC/USDT', 'ETH/USDT', 'BCH/USDT', 'BNB/USDT',
]

# Metals moved to metals-scanner.py (cTrader). scanner.py is crypto-only now.
# FUTURES_SYMBOLS kept (empty) so the `not in FUTURES_SYMBOLS` guards still resolve
# (every symbol is crypto → regime/volatility/btc_state apply to all).
FUTURES_SYMBOLS = []

# Combine all symbols
SYMBOLS = SPOT_SYMBOLS + FUTURES_SYMBOLS

# ============================================
# BTC DOMINANCE / REGIME ENGINE (tunable)
# ============================================
# The composite BTC state combines BTC's price direction with a *dominance* proxy
# (BTC's performance vs an alt basket). Rising dominance = capital fleeing into BTC
# → alts bleed → fade alt longs. Falling dominance = altseason rotation → favour longs.
# Broadened alt proxy for BTC dominance. A 2-coin (ETH/SOL) basket was too narrow —
# one alt's idiosyncratic move swung the read. This spread of liquid majors tracks
# "alts as a class" far better. Each is a small extra fetch/scan (lookback≈20 bars);
# failures are dropped (see _avg_change), so a missing coin just shrinks the basket.
DOMINANCE_BASKET = config.get_list("DOMINANCE_BASKET",
                    ['ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT',
                     'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT'])
BTC_PRICE_THRESHOLD = config.get_float("BTC_PRICE_THRESHOLD", 0.5)   # % move (avg 5/10-bar) to call BTC bullish/bearish (else neutral)
BTC_DOMINANCE_THRESHOLD = config.get_float("BTC_DOMINANCE_THRESHOLD", 0.3)  # BTC-minus-basket %; above → dominance RISING, below −thr → FALLING

# Direction-aware confidence adjustment (percentage points) per composite regime,
# applied to CRYPTO signals only (metals exempt). Tune freely; 0 = no effect.
# Each cell is .env-overridable per-scanner, e.g. CRYPTO_BTC_D_RISING_BULLISH_BUY=-30.
_BTC_REGIME_CONFIDENCE_ADJ_DEFAULTS = {
    # Dominance RISING → alts underperform → fade longs, favour shorts
    'BTC_D_RISING_BULLISH':  {'BUY': -35, 'SELL': +15},
    'BTC_D_RISING_BEARISH':  {'BUY': -40, 'SELL': +20},
    'BTC_D_RISING_NEUTRAL':  {'BUY': -25, 'SELL': +10},
    # Dominance FALLING → altseason rotation → favour longs
    'BTC_D_FALLING_BULLISH': {'BUY': +20, 'SELL': -25},
    'BTC_D_FALLING_BEARISH': {'BUY':  -5, 'SELL': +10},
    'BTC_D_FALLING_NEUTRAL': {'BUY': +10, 'SELL': -10},
    # Dominance FLAT → BTC price direction leads
    'BTC_D_FLAT_BULLISH':    {'BUY': +10, 'SELL': -10},
    'BTC_D_FLAT_BEARISH':    {'BUY': -15, 'SELL': +10},
    'BTC_D_FLAT_NEUTRAL':    {'BUY':   0, 'SELL':   0},
}
BTC_REGIME_CONFIDENCE_ADJ = {
    state: {d: config.get_int(f"{state}_{d}", v) for d, v in cells.items()}
    for state, cells in _BTC_REGIME_CONFIDENCE_ADJ_DEFAULTS.items()
}

# Hard regime filter: a signal whose direction fights the macro regime is blocked
# unless its confidence clears this override. Metals exempt.
REGIME_HARD_FILTER_MIN_CONF = config.get_int("REGIME_HARD_FILTER_MIN_CONF", 70)
REGIME_BLOCKS = {                      # composite_state -> direction that is blocked
    'BTC_D_RISING_BULLISH':  'BUY',    # don't long alts while BTC dominance pumps
    'BTC_D_RISING_BEARISH':  'BUY',    # alt-crush regime — hardest block on longs
    'BTC_D_RISING_NEUTRAL':  'BUY',
    'BTC_D_FALLING_BULLISH': 'SELL',   # don't short alts in altseason
}

def should_allow_signal(signal_type, composite_state, confidence):
    """False → drop the signal (it fights the macro regime below the override conf)."""
    blocked = REGIME_BLOCKS.get(composite_state)
    if blocked is None:
        return True
    direction = 'BUY' if signal_type.startswith('BUY') else 'SELL'
    return not (direction == blocked and confidence < REGIME_HARD_FILTER_MIN_CONF)

# ============================================
# BTC VOLATILITY CIRCUIT BREAKER
# ============================================
# Orthogonal to the regime engine. The regime decides *direction*; this decides
# "is BTC too violent for counter-trend signals to be trusted right now?". When
# BTC's recent volatility spikes above its own baseline (parabolic move), counter-
# trend crypto signals (SELL while BTC bullish / BUY while BTC bearish) are paused.
# Timeframe-agnostic: uses the ratio of short- vs long-window return volatility, so
# no per-timeframe threshold table is needed. Metals exempt.
BTC_VOLATILITY_SHORT_WINDOW = config.get_int("BTC_VOLATILITY_SHORT_WINDOW", 10)   # bars for "recent" volatility
BTC_VOLATILITY_LONG_WINDOW  = config.get_int("BTC_VOLATILITY_LONG_WINDOW", 40)    # bars for the baseline (prior period)
BTC_VOLATILITY_RATIO = config.get_float("BTC_VOLATILITY_RATIO", 2.0)              # recent/baseline stdev above this → EXPLOSIVE
BTC_VOLATILITY_MIN_CONF = config.get_int("BTC_VOLATILITY_MIN_CONF", 85)           # soft mode only: counter-trend needs ≥ this to survive
BTC_VOLATILITY_HARD_PAUSE = config.get_bool("BTC_VOLATILITY_HARD_PAUSE", True)    # True → pause ALL counter-trend when explosive; False → soft (min-conf)
BTC_VOLATILITY_FAST_BAR_ATR = config.get_float("BTC_VOLATILITY_FAST_BAR_ATR", 2.5)  # #1: a single BTC bar this many ATRs wide trips the breaker
                                   #     immediately (the lagging stdev ratio misses one-bar spikes)

# ============================================
# STRATEGY LEVELS (TP1 tighten + ATR stops/targets)  → moved to core/strategy.py
# ============================================
# TP1_TIGHTEN_FACTOR + USE_ATR_LEVELS/ATR_*_MULT/ATR_STOP_* live in core/strategy.py,
# shared with metals-scanner.py and read by strategy.calculate_entry_exit.

# ============================================
# ANTI-BREAKOUT / RSI-CONTINUATION GUARDS  → moved to core/guards.py
# ============================================
# The July-4 hardening (#2 adverse impulse, #3 RSI continuation, #4 no-re-arm,
# #5 volatility spike) + its tunable constants now live in core/guards.py, shared
# with metals-scanner.py. Call sites below use `guards.<NAME>`. The BTC-specific #1
# volatility circuit breaker (should_pause_counter_trend + BTC_VOLATILITY_*) stays here.


def should_pause_counter_trend(signal_type, btc_price_dir, explosive, confidence):
    """True → drop the signal: it's counter-trend during an explosive BTC move.
    Counter-trend = SELL while BTC is bullish, or BUY while BTC is bearish."""
    if not explosive or btc_price_dir not in ('BULLISH', 'BEARISH'):
        return False
    direction = 'BUY' if signal_type.startswith('BUY') else 'SELL'
    counter = (direction == 'SELL' and btc_price_dir == 'BULLISH') or \
              (direction == 'BUY' and btc_price_dir == 'BEARISH')
    if not counter:
        return False
    return True if BTC_VOLATILITY_HARD_PAUSE else confidence < BTC_VOLATILITY_MIN_CONF

# ============================================
# TIMEFRAME-SPECIFIC PARAMETERS
# ============================================

# get_timeframe_params()  → moved to core/strategy.py (imported at top)

# ============================================
# INDICATOR FUNCTIONS  (shared — see core/indicators.py)
# ============================================
from core.indicators import (
    gaussian_kernel, nadaraya_watson_envelope, rsi, squeeze_momentum,
    smre_filter, stationarity_test, volatility_regime,
    detect_market_structure, find_order_block, find_fair_value_gap,
)

# ============================================
# CACHED EXCHANGE
# ============================================

_EXCHANGES = {}

def get_exchange(is_futures):
    key = 'futures' if is_futures else 'spot'
    if key not in _EXCHANGES:
        if is_futures:
            _EXCHANGES[key] = ccxt.binanceusdm({
                'enableRateLimit': True,
                'options': {'defaultType': 'future'}
            })
        else:
            _EXCHANGES[key] = ccxt.binance({
                'enableRateLimit': True,
                'options': {'defaultType': 'spot'}
            })
    return _EXCHANGES[key]

# Transient Binance hiccups (timeouts, 5xx, rate-limit blips) used to drop a symbol
# for the whole scan. Retry a few times with exponential backoff before giving up.
FETCH_RETRIES = 3       # total attempts
FETCH_BACKOFF = 0.5     # seconds; doubles each retry (0.5, 1.0, 2.0…)

def fetch_data(symbol, timeframe, limit=550):
    is_futures = ':' in symbol
    exchange = get_exchange(is_futures)

    last_err = None
    for attempt in range(FETCH_RETRIES):
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            return pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        except Exception as e:
            last_err = e
            if attempt < FETCH_RETRIES - 1:
                time.sleep(FETCH_BACKOFF * (2 ** attempt))

    print(f"⚠️ {symbol}: fetch error after {FETCH_RETRIES} tries - {str(last_err)[:60]}")
    return None

def fetch_data_batch(symbols, timeframe, limit, max_workers=8):
    """Fetch OHLCV for many symbols concurrently. Returns {symbol: df|None}.
    Cuts a ~50-symbol scan from serial (~1 req at a time) to a handful of batches.
    Per-symbol errors are isolated (fetch_data already returns None on failure)."""
    out = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(fetch_data, s, timeframe, limit): s for s in symbols}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                out[sym] = fut.result()
            except Exception:
                out[sym] = None
    return out

def check_timeframe_confirmation(symbol, timeframe, rsi_period, signal_direction='BUY', rsi_threshold=35):
    """
    Fix #7: original always checked rsi < threshold (bullish confirmation only).
    Now accepts signal_direction so SELL signals check rsi > (100 - threshold).
    """
    df = fetch_data(symbol, timeframe, limit=100)
    if df is None or len(df) < 50:
        return False, None

    close = df['close'].values
    rsi_val = rsi(close[-rsi_period - 20:], rsi_period)

    if signal_direction == 'BUY':
        confirms = rsi_val < rsi_threshold          # oversold on higher TF → bullish
    else:
        confirms = rsi_val > (100 - rsi_threshold)  # overbought on higher TF → bearish

    return confirms, round(rsi_val, 2)

# ============================================
# BTC COMPOSITE STATE (price direction + dominance)
# ============================================

def _avg_change(symbol, timeframe, lookback_candles=20):
    """Average of the 5-bar and 10-bar % change on `timeframe`. None on failure."""
    df = fetch_data(symbol, timeframe, limit=lookback_candles)
    if df is None or len(df) < 10:
        return None
    close = df['close'].values
    cur = close[-1]
    p5 = close[-5] if len(close) >= 5 else cur
    p10 = close[-10] if len(close) >= 10 else cur
    return ((cur - p5) / p5 * 100 + (cur - p10) / p10 * 100) / 2

def _regime_description(dominance, price_dir):
    if dominance == 'RISING':
        return 'BTC DOMINANCE RISING — alts bleeding (ALT CRUSH risk)'
    if dominance == 'FALLING':
        return 'BTC DOMINANCE FALLING — capital rotating to alts (ALTSEASON)'
    return f'DOMINANCE FLAT — following BTC {price_dir.lower()}'

def get_btc_full_state(timeframe, lookback_candles=20):
    """Composite BTC regime on the SAME timeframe as the scan.

    Combines BTC's price direction with a dominance proxy (BTC vs a basket of
    liquid alts). Returns (composite_state, meta) where composite_state is one of the
    BTC_D_<RISING|FALLING|FLAT>_<BULLISH|BEARISH|NEUTRAL> keys in
    BTC_REGIME_CONFIDENCE_ADJ, and meta carries the numbers for the dashboard.
    """
    default = ('BTC_D_FLAT_NEUTRAL', {
        'price_dir': 'NEUTRAL', 'dominance': 'FLAT', 'btc_change': 0.0,
        'basket_change': 0.0, 'rel': 0.0,
        'description': _regime_description('FLAT', 'NEUTRAL'), 'alt_bias': 'NEUTRAL',
        'explosive': False, 'vol_ratio': 1.0, 'impulse_dir': 'NEUTRAL'
    })
    try:
        # Fetch BTC once, deep enough for both the change read and the volatility ratio.
        need = max(lookback_candles, BTC_VOLATILITY_LONG_WINDOW + 5)
        btc_df = fetch_data('BTC/USDT', timeframe, limit=need)
        if btc_df is None or len(btc_df) < 10:
            return default
        close = btc_df['close'].values
        cur = close[-1]
        p5 = close[-5] if len(close) >= 5 else cur
        p10 = close[-10] if len(close) >= 10 else cur
        btc_change = ((cur - p5) / p5 * 100 + (cur - p10) / p10 * 100) / 2

        # Volatility circuit breaker: recent vs baseline stdev of bar-to-bar returns.
        explosive, vol_ratio = False, 1.0
        rets = np.diff(close) / close[:-1]
        if len(rets) >= BTC_VOLATILITY_LONG_WINDOW:
            recent = np.std(rets[-BTC_VOLATILITY_SHORT_WINDOW:])
            base = rets[-BTC_VOLATILITY_LONG_WINDOW:-BTC_VOLATILITY_SHORT_WINDOW]
            baseline = np.std(base) if len(base) else np.std(rets[-BTC_VOLATILITY_LONG_WINDOW:])
            if baseline > 0:
                vol_ratio = float(recent / baseline)
                explosive = vol_ratio > BTC_VOLATILITY_RATIO

        # #1 Fast trigger: a single outsized bar trips the breaker immediately, before the
        # lagging stdev ratio catches up. The July-4 blowup was a one-bar vertical move.
        atr = guards._atr_pct(btc_df['high'].values, btc_df['low'].values, close)
        if atr and len(close) > 1:
            last_range_atr = (btc_df['high'].values[-1] - btc_df['low'].values[-1]) / close[-2] * 100 / atr
            if last_range_atr >= BTC_VOLATILITY_FAST_BAR_ATR:
                explosive = True

        # #1 Direction of the latest impulse (sign of the last-2-bar move). Used as the
        # effective direction when the smoothed 5/10-bar price_dir reads NEUTRAL during a
        # fast move — the exact gap that let counter-trend fades through on July 4.
        impulse_dir = 'NEUTRAL'
        if len(close) > 2:
            imp = (close[-1] - close[-3]) / close[-3] * 100
            if imp > BTC_PRICE_THRESHOLD:
                impulse_dir = 'BULLISH'
            elif imp < -BTC_PRICE_THRESHOLD:
                impulse_dir = 'BEARISH'

        basket = [c for c in (_avg_change(s, timeframe, lookback_candles) for s in DOMINANCE_BASKET) if c is not None]
        basket_change = sum(basket) / len(basket) if basket else btc_change

        # Price direction
        if btc_change > BTC_PRICE_THRESHOLD:
            price_dir = 'BULLISH'
        elif btc_change < -BTC_PRICE_THRESHOLD:
            price_dir = 'BEARISH'
        else:
            price_dir = 'NEUTRAL'

        # Dominance = BTC performance relative to the alt basket
        rel = btc_change - basket_change
        if rel > BTC_DOMINANCE_THRESHOLD:
            dominance = 'RISING'
        elif rel < -BTC_DOMINANCE_THRESHOLD:
            dominance = 'FALLING'
        else:
            dominance = 'FLAT'

        composite = f'BTC_D_{dominance}_{price_dir}'
        alt_bias = {'RISING': 'SHORT-FAVORED', 'FALLING': 'LONG-FAVORED', 'FLAT': 'NEUTRAL'}[dominance]
        meta = {
            'price_dir': price_dir, 'dominance': dominance,
            'btc_change': round(btc_change, 2), 'basket_change': round(basket_change, 2),
            'rel': round(rel, 2),
            'description': _regime_description(dominance, price_dir), 'alt_bias': alt_bias,
            'explosive': explosive, 'vol_ratio': round(vol_ratio, 2),
            'impulse_dir': impulse_dir,
        }
        return composite, meta

    except Exception as e:
        print(f"⚠️ BTC state check error: {str(e)[:60]}")
        return default

# ============================================
# POSITION SIZING CALCULATOR
# ============================================

# calculate_position_size()  → moved to core/strategy.py (imported at top)

# ============================================
# FEED WRITER
# ============================================

def write_to_feed(signals, timeframe, btc_state=None, feed_path="./data/alerts.json"):
    # Thin driver over the shared feed contract (core/feed.py). Crypto-specific bits
    # are passed in: the signal_source tag, the (empty) futures set, and the re-arm guard.
    _core_write_to_feed(
        signals, timeframe,
        signal_source="signal_scanner",
        btc_state=btc_state,
        feed_path=feed_path,
        futures_symbols=FUTURES_SYMBOLS,
        readvancing_fade=guards._is_readvancing_fade,
    )

# ============================================
# SUGGESTED ENTRY/EXIT PRICES (3 TARGETS)
# ============================================

# calculate_entry_exit()  → moved to core/strategy.py (imported at top)

# ============================================
# ENHANCED SIGNAL DETECTION WITH SQUEEZE + SMRE + SMC
# ============================================

def detect_signals(price, high, low, volume, rsi_val, lower, upper, mid, symbol, params, use_squeeze=True, use_smre=True, use_smc=True, regime=None, btc_volatile=False, btc_price_dir='NEUTRAL'):
    # Thin driver over the shared detector (core/strategy.py). The BTC-regime tail is
    # supplied as two hooks (inert when regime is None / symbol is a future); the higher-
    # timeframe RSI confirmation is this scanner's Binance-backed fetch.
    def _regime_adjust(signal_type, sym, confidence):
        msgs = []
        if sym not in FUTURES_SYMBOLS and regime:
            direction = 'BUY' if signal_type.startswith('BUY') else 'SELL'
            adj = BTC_REGIME_CONFIDENCE_ADJ.get(regime, {}).get(direction, 0)
            if adj:
                confidence += adj
                msgs.append(f"₿ {regime}: {adj:+d} conf")
        return confidence, msgs

    def _regime_gate(signal_type, sym, confidence):
        msgs = []
        skip = False
        if sym not in FUTURES_SYMBOLS and regime and not should_allow_signal(signal_type, regime, confidence):
            skip = True
            msgs.append(f"⛔ {regime} blocks {signal_type} (conf {confidence:.0f} < {REGIME_HARD_FILTER_MIN_CONF})")
        if sym not in FUTURES_SYMBOLS and should_pause_counter_trend(signal_type, btc_price_dir, btc_volatile, confidence):
            skip = True
            msgs.append(f"⚡ BTC explosive — counter-trend {signal_type} paused")
        return skip, msgs

    return strategy.detect_signals(
        price, high, low, volume, rsi_val, lower, upper, mid, symbol, params,
        use_squeeze, use_smre, use_smc,
        confirm_fn=check_timeframe_confirmation,
        regime_adjust=_regime_adjust, regime_gate=_regime_gate,
    )

# ============================================
# MAIN SCAN FUNCTION
# ============================================

def scan_with_signals(timeframe, verbose, account_size, risk_percent, max_positions, use_squeeze=True, use_smre=True, use_smc=True):
    params = get_timeframe_params(timeframe)
    results = []
    
    # Composite BTC regime (price direction + dominance) on the scan timeframe
    regime, regime_meta = get_btc_full_state(timeframe)
    btc_volatile = regime_meta.get('explosive', False)
    btc_price_dir = regime_meta.get('price_dir', 'NEUTRAL')
    # #1 During an explosive move the smoothed price_dir often still reads NEUTRAL (the
    # spike is diluted by the 5/10-bar average) — the exact hole that let July-4 SELLs
    # through. Fall back to the latest impulse direction so the breaker can actually arm.
    if btc_volatile and btc_price_dir == 'NEUTRAL':
        btc_price_dir = regime_meta.get('impulse_dir', 'NEUTRAL')

    print(f"\n{'='*110}")
    print(f"📊 MULTI-ASSET SCANNER: {timeframe} | {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'='*110}")
    print(f"Account: ${account_size:,} | Risk: {risk_percent*100:.1f}% per trade | Max Positions: {max_positions}")
    print(f"Parameters: Bandwidth={params['bandwidth']}, Multiplier={params['multiplier']}, RSI={params['rsi_period']}")
    print(f"Confirmation: {params['confirmation_timeframe']} | MA{params['ma_period']} | Targets: {params['target_1_pct']*100:.0f}%/{params['target_2_pct']*100:.0f}%/{params['target_3_pct']*100:.0f}%")
    print(f"Symbols: {len(SPOT_SYMBOLS)} Spot + {len(FUTURES_SYMBOLS)} Futures")
    print(f"Filters: Squeeze={'✅' if use_squeeze else '❌'} | SMRE={'✅' if use_smre else '❌'} | SMC={'✅' if use_smc else '❌'}")
    # ── BTC REGIME DASHBOARD ────────────────────────────────────────────────
    dom_icon = {'RISING': '🔺', 'FALLING': '🔻', 'FLAT': '➡️'}.get(regime_meta['dominance'], '➡️')
    print(f"{'-'*110}")
    print(f"🧭 BTC REGIME: {regime}")
    print(f"   {dom_icon} BTC {regime_meta['btc_change']:+.2f}%  |  Alt basket {regime_meta['basket_change']:+.2f}%  "
          f"|  Rel {regime_meta['rel']:+.2f}%  →  Dominance {regime_meta['dominance']}")
    print(f"   {regime_meta['description']}")
    print(f"   Altcoin bias: {regime_meta['alt_bias']}")
    if btc_volatile:
        mode = 'HARD-pause all' if BTC_VOLATILITY_HARD_PAUSE else f'soft (<{BTC_VOLATILITY_MIN_CONF})'
        print(f"   ⚡ BTC VOLATILITY: EXPLOSIVE (x{regime_meta['vol_ratio']:.1f} baseline) — counter-trend paused [{mode}]")
    else:
        print(f"   ⚡ BTC volatility: calm (x{regime_meta['vol_ratio']:.1f} baseline)")
    print(f"{'='*110}\n")

    # Fetch all symbols concurrently (D), then scan from the pre-fetched map.
    data_map = fetch_data_batch(SYMBOLS, timeframe, params['lookback'] + 50, max_workers=8)

    for symbol in SYMBOLS:
        try:
            df = data_map.get(symbol)
            if df is None or len(df) < params['lookback']:
                continue
            
            close = df['close'].values
            high = df['high'].values
            low = df['low'].values
            volume = df['volume'].values
            
            mid, upper, lower = nadaraya_watson_envelope(
                close, params['bandwidth'], params['multiplier'], params['lookback']
            )
            
            if mid is None:
                continue
            
            rsi_val = rsi(close[-params['rsi_period']-30:], params['rsi_period'])
            current_price = close[-1]
            
            signals = detect_signals(
                close, high, low, volume, rsi_val, lower, upper, mid, symbol, params,
                use_squeeze=use_squeeze, use_smre=use_smre, use_smc=use_smc, regime=regime,
                btc_volatile=btc_volatile, btc_price_dir=btc_price_dir
            )
            
            if signals:
                best = signals[0]
                
                entry_exit = calculate_entry_exit(
                    current_price, lower, upper, mid,
                    best['type'], best['confidence'], rsi_val, params,
                    rsi_1h=best.get('rsi_1h'),
                    atr_pct=guards._atr_pct(high, low, close, strategy.ATR_LEVEL_WINDOW)
                )
                
                position_size = calculate_position_size(
                    current_price, entry_exit['stop_loss'], best['confidence'],
                    account_size, risk_percent
                )
                
                position = "Inside"
                if current_price < lower:
                    position = "Below Lower"
                elif current_price > upper:
                    position = "Above Upper"
                
                # Build filter string with all indicators
                filter_parts = []
                if best.get('filters'):
                    filter_parts.extend(best['filters'])
                if 'squeeze_on' in best:
                    filter_parts.append(f"Squeeze: {'ON' if best['squeeze_on'] else 'OFF'}")
                if 'squeeze_release' in best and best['squeeze_release']:
                    filter_parts.append("🔥 RELEASE")
                if 'z_score' in best:
                    filter_parts.append(f"Z: {best['z_score']:.2f}")
                if 'hurst' in best:
                    filter_parts.append(f"H: {best['hurst']:.2f}")
                if 'vol_regime' in best:
                    filter_parts.append(f"Vol: {best['vol_regime']}")
                if 'smc_trend' in best:
                    filter_parts.append(f"SMC: {best['smc_trend'].upper()}")
                if 'smc_structure' in best and best['smc_structure'] != 'neutral':
                    filter_parts.append(f"Structure: {best['smc_structure'].upper()}")
                
                results.append({
                    'symbol': symbol,
                    'price': current_price,
                    'signal_type': best['type'],
                    'confidence': best['confidence'],
                    'description': best['description'],
                    'filters': ', '.join(filter_parts) if filter_parts else 'None',
                    'rsi': round(rsi_val, 2),
                    'lower': round(lower, 2),
                    'upper': round(upper, 2),
                    'mid': round(mid, 2),
                    'position': position,
                    'entry': entry_exit['entry'],
                    'stop_loss': entry_exit['stop_loss'],
                    'tp1': entry_exit['take_profit_1'],
                    'tp2': entry_exit['take_profit_2'],
                    'tp3': entry_exit['take_profit_3'],
                    'target_1_gain': entry_exit['target_1_gain'],
                    'target_2_gain': entry_exit['target_2_gain'],
                    'target_3_gain': entry_exit['target_3_gain'],
                    'risk_reward_1': entry_exit['risk_reward_1'],
                    'risk_reward_2': entry_exit['risk_reward_2'],
                    'risk_reward_3': entry_exit['risk_reward_3'],
                    'position_size': position_size['size'],
                    'position_value': position_size['value'],
                    'risk_amount': position_size['risk_amount'],
                    'risk_percent': position_size['risk_percent']
                })
            else:
                if verbose:
                    position = "Inside"
                    if current_price < lower:
                        position = "Below Lower"
                    elif current_price > upper:
                        position = "Above Upper"
                    
                    results.append({
                        'symbol': symbol,
                        'price': current_price,
                        'signal_type': 'NEUTRAL',
                        'confidence': 0,
                        'description': 'No signal',
                        'filters': 'N/A',
                        'rsi': round(rsi_val, 2),
                        'lower': round(lower, 2),
                        'upper': round(upper, 2),
                        'mid': round(mid, 2),
                        'position': position,
                        'entry': None,
                        'stop_loss': None,
                        'tp1': None,
                        'tp2': None,
                        'tp3': None,
                        'target_1_gain': None,
                        'target_2_gain': None,
                        'target_3_gain': None,
                        'risk_reward_1': None,
                        'risk_reward_2': None,
                        'risk_reward_3': None,
                        'position_size': None,
                        'position_value': None,
                        'risk_amount': None,
                        'risk_percent': None
                    })
                
        except Exception as e:
            print(f"❌ {symbol}: Error - {str(e)[:80]}")
    
    # Convert to DataFrame and sort
    df_results = pd.DataFrame(results)
    
    if len(df_results) == 0:
        print("No results found")
        return df_results
    
    df_results = df_results.sort_values('confidence', ascending=False)
    
    # DISPLAY - Signal Summary
    signals_df = df_results[df_results['signal_type'].str.startswith(('BUY', 'SELL'))]
    
    if len(signals_df) > 0:
        print(f"{'SYMBOL':<14} {'PRICE':<10} {'SIGNAL':<18} {'CONF':<6} {'RSI':<8} {'POSITION':<15} {'FILTERS'}")
        print("-"*110)
        
        for _, row in signals_df.iterrows():
            emoji = "🔴" if row['signal_type'].startswith('SELL') else "🟢"
            conf_display = f"{row['confidence']}%"
            filters_display = row['filters'][:40] + '...' if len(row['filters']) > 40 else row['filters']
            symbol_display = row['symbol'][:14]
            print(f"{symbol_display:<14} ${row['price']:<9.2f} {emoji} {row['signal_type']:<16} {conf_display:<5}  {row['rsi']:<6}  {row['position']:<15} {filters_display}")
        
        # DISPLAY - Detailed Trading Plans
        print(f"\n{'='*110}")
        print("📊 TRADING PLANS (3 Targets)")
        print(f"{'='*110}\n")
        
        for _, row in signals_df.iterrows():
            print(f"🎯 {row['symbol']} - {row['signal_type']} (Confidence: {row['confidence']}%)")
            print(f"   📍 Entry: ${row['entry']:.4f}")
            print(f"   🛑 Stop Loss: ${row['stop_loss']:.4f} (Risk: ${row['risk_amount']:.2f} | {row['risk_percent']:.2f}% of account)")
            print(f"   🎯 TP1: ${row['tp1']:.4f} (+{row['target_1_gain']:.1f}%) | R:R {row['risk_reward_1']:.2f}")
            print(f"   🎯 TP2: ${row['tp2']:.4f} (+{row['target_2_gain']:.1f}%) | R:R {row['risk_reward_2']:.2f}")
            print(f"   🎯 TP3: ${row['tp3']:.4f} (+{row['target_3_gain']:.1f}%) | R:R {row['risk_reward_3']:.2f}")
            print(f"   📊 Position Size: {row['position_size']:.4f} units (${row['position_value']:.2f})")
            print(f"   🔍 Filters: {row['filters']}")
            print()
    else:
        print("📭 No signals detected in this scan.")
    
    # DISPLAY - Summary
    buy_signals = df_results[df_results['signal_type'].str.startswith('BUY')]
    sell_signals = df_results[df_results['signal_type'].str.startswith('SELL')]
    neutral = df_results[df_results['signal_type'] == 'NEUTRAL']
    
    print(f"\n{'='*110}")
    print(f"SUMMARY: {len(buy_signals)} BUY | {len(sell_signals)} SELL | {len(neutral)} NEUTRAL | {len(df_results)} TOTAL")
    
    if len(buy_signals) > 0:
        print("\n🟢 TOP BUY SIGNALS:")
        for _, row in buy_signals.head(3).iterrows():
            print(f"   {row['symbol']}: {row['description']}")
            print(f"      Entry: ${row['entry']:.4f} | Stop: ${row['stop_loss']:.4f}")
            print(f"      TP1: ${row['tp1']:.4f} | TP2: ${row['tp2']:.4f} | TP3: ${row['tp3']:.4f}")
    
    if len(sell_signals) > 0:
        print("\n🔴 TOP SELL SIGNALS:")
        for _, row in sell_signals.head(3).iterrows():
            print(f"   {row['symbol']}: {row['description']}")
            print(f"      Entry: ${row['entry']:.4f} | Stop: ${row['stop_loss']:.4f}")
            print(f"      TP1: ${row['tp1']:.4f} | TP2: ${row['tp2']:.4f} | TP3: ${row['tp3']:.4f}")
    
    print(f"{'='*110}")

    # Write detected signals to the feed (btc_state attached to crypto entries)
    write_to_feed(signals_df.to_dict('records'), timeframe, btc_state=regime)

    # Display BTC state again after scan
    print(f"\n🧭 BTC Regime: {regime} — {regime_meta['description']} (Altcoin bias: {regime_meta['alt_bias']})")

    return df_results

# ============================================
# RUN
# ============================================

def main():
    args = parse_args()
    
    # SMC built-in functions are always available; respect --no-smc flag only
    use_smc = not args.no_smc
    
    # List timeframes
    if args.list_timeframes:
        print("\n📊 Available Timeframes:")
        print("  ⏱️ 1m   - Scalping (very active)")
        print("  ⏱️ 5m   - Scalping")
        print("  ⏱️ 15m  - Day trading")
        print("  ⏱️ 30m  - Day/Swing trading")
        print("  ⏱️ 1h   - Swing trading (default)")
        print("  ⏱️ 2h   - Swing trading")
        print("  ⏱️ 4h   - Swing/Position trading")
        print("  ⏱️ 6h   - Position trading")
        print("  ⏱️ 12h  - Position trading")
        print("  ⏱️ 1d   - Long-term position trading")
        print("\n💡 Recommended scan frequencies:")
        print("  1m-15m: Every 5-15 minutes")
        print("  30m-1h: Every 30-60 minutes")
        print("  2h-4h:  Every 2-4 hours")
        print("  6h-1d:  Every 6-24 hours")
        sys.exit(0)
    
    # Validate timeframe
    valid_timeframes = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']
    if args.timeframe not in valid_timeframes:
        print(f"❌ Invalid timeframe: {args.timeframe}")
        print(f"   Valid options: {', '.join(valid_timeframes)}")
        print(f"   Use --list-timeframes for more details")
        sys.exit(1)
    
    print("🔍 Starting Enhanced Multi-Asset Scanner...")
    print(f"   Timeframe: {args.timeframe}")
    print(f"   Account: ${args.account_size:,}")
    print(f"   Risk per trade: {args.risk*100:.1f}%")
    print(f"   Max positions: {args.max_positions}")
    if args.verbose:
        print("   Verbose mode: ON (showing all symbols)")
    print(f"   Squeeze Momentum: {'ENABLED' if not args.no_squeeze else 'DISABLED'}")
    print(f"   SMRE Filters: {'ENABLED' if not args.no_smre else 'DISABLED'}")
    print(f"   SMC Filters: {'ENABLED' if use_smc else 'DISABLED'}")
    
    def _run_once():
        t0 = time.time()
        scan_with_signals(
            args.timeframe,
            args.verbose,
            args.account_size,
            args.risk,
            args.max_positions,
            use_squeeze=not args.no_squeeze,
            use_smre=not args.no_smre,
            use_smc=use_smc
        )
        print(f"\n⏱️ Scan completed in {time.time() - t0:.2f} seconds")

    if args.loop > 0:
        interval = args.loop * 60
        print(f"🔁 Loop mode: scanning every {args.loop} min (aligned to the clock). Ctrl-C to stop.")
        while True:
            try:
                _run_once()
                # Sleep to the next wall-clock interval boundary so runs land on
                # round times (e.g. :00/:15/:30/:45 for --loop 15) and the process
                # stays continuously online instead of exiting between scans.
                sleep_for = interval - (time.time() % interval)
                print(f"😴 Next scan in {sleep_for/60:.1f} min...\n")
                time.sleep(sleep_for)
            except KeyboardInterrupt:
                print("\n👋 Scanner stopped.")
                break
    else:
        _run_once()
        if args.timeframe in ['1m', '5m', '15m']:
            print(f"\n💡 Recommended scan frequency: Every {args.timeframe} (or more frequently for scalping)")
        elif args.timeframe in ['30m', '1h']:
            print(f"\n💡 Recommended scan frequency: Every 30-60 minutes")
        elif args.timeframe in ['2h', '4h']:
            print(f"\n💡 Recommended scan frequency: Every {args.timeframe}")
        else:
            print(f"\n💡 Recommended scan frequency: Every {args.timeframe} or daily")

if __name__ == "__main__":
    main()
