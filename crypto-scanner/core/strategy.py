"""Shared strategy plumbing — timeframe params, position sizing, entry/exit levels.

These three functions were functionally identical across scanner.py and metals-scanner.py.
They live here now as the single source of truth, together with the ATR-scaled stop/target
tunables and the TP1-tightening factor that `calculate_entry_exit` reads.

Like core/guards.py, the constants are module-level and read by the functions as globals, so
a driver may override one for its own process via `strategy.<NAME> = ...` at startup.

The mean-reversion signal detector (detect_signals) is NOT here yet — it still differs between
the two scanners by the BTC-regime block and is reconciled separately.

NOTE: xau-scanner.py (momentum) has its own sizing/level logic and does not use this module.
"""
import numpy as np

from core import config
from core import guards
from core.indicators import (
    squeeze_momentum, smre_filter, stationarity_test, volatility_regime,
    detect_market_structure, find_order_block, find_fair_value_gap,
)

# All tunable via .env (see core/config.py); defaults below are today's values.
# --- TP1 tightening: pull the feed's executed target toward entry for a more-probable
#     fill. 1.0 = original TP1, 0.5 = halfway to entry, smaller = tighter. SL unchanged. ---
TP1_TIGHTEN_FACTOR = config.get_float("TP1_TIGHTEN_FACTOR", 0.5)

# --- #6 ATR-scaled stops & targets: adapt to volatility so levels breathe; a wider ATR
#     stop auto-shrinks position size (size = risk / stop_distance) on violent days. ---
USE_ATR_LEVELS   = config.get_bool("USE_ATR_LEVELS", True)
ATR_LEVEL_WINDOW = config.get_int("ATR_LEVEL_WINDOW", 14)     # bars for the ATR used to place stop/TP
ATR_STOP_MULT    = config.get_float("ATR_STOP_MULT", 1.5)     # stop distance in ATRs
ATR_TP1_MULT     = config.get_float("ATR_TP1_MULT", 1.0)      # TP1 distance in ATRs — conservative/near (the feed's executed target)
ATR_TP2_MULT     = config.get_float("ATR_TP2_MULT", 2.0)      # scale-out target
ATR_TP3_MULT     = config.get_float("ATR_TP3_MULT", 3.0)      # scale-out target
# Clamp the ATR stop to a sane band around the timeframe's legacy %-stop so a near-zero ATR
# can't create a microscopic stop (→ oversized position) nor an absurdly wide one.
ATR_STOP_MIN_FRAC_OF_PCT = config.get_float("ATR_STOP_MIN_FRAC_OF_PCT", 0.5)
ATR_STOP_MAX_FRAC_OF_PCT = config.get_float("ATR_STOP_MAX_FRAC_OF_PCT", 2.0)

# --- Signal filter weights (group E) — per-filter weight %, plus a global scale --------
# Each filter's confidence contribution is scaled by (W_<FILTER>_PCT/100) x (SIGNAL_WEIGHT_PCT/100).
# All default 100 -> today's behaviour. Tune per-scanner, e.g. CRYPTO_W_STRUCTURE_PCT=150
# (SMC structure matters 50% more for crypto) or SIGNAL_WEIGHT_PCT=80 (dampen all filters).
SIGNAL_WEIGHT_PCT  = config.get_float("SIGNAL_WEIGHT_PCT", 100.0)   # global scale on every filter delta
W_VOLUME_PCT       = config.get_float("W_VOLUME_PCT", 100.0)        # volume confirmation / divergence
W_MA_PCT           = config.get_float("W_MA_PCT", 100.0)            # MA trend alignment
W_HTF_PCT          = config.get_float("W_HTF_PCT", 100.0)           # higher-timeframe RSI confirmation
W_DIVERGENCE_PCT   = config.get_float("W_DIVERGENCE_PCT", 100.0)    # RSI/price divergence
W_VELOCITY_PCT     = config.get_float("W_VELOCITY_PCT", 100.0)      # price-velocity (blow-off) penalty
W_HTF_OVERRULE_PCT = config.get_float("W_HTF_OVERRULE_PCT", 100.0)  # 1h RSI overrule of counter signals
W_SQUEEZE_PCT      = config.get_float("W_SQUEEZE_PCT", 100.0)       # squeeze-momentum release
W_SMRE_PCT         = config.get_float("W_SMRE_PCT", 100.0)          # SMRE (z-score / Hurst / vol-regime)
W_STRUCTURE_PCT    = config.get_float("W_STRUCTURE_PCT", 100.0)     # SMC market structure (BOS/CHoCH)
W_OB_PCT           = config.get_float("W_OB_PCT", 100.0)            # SMC order block
W_FVG_PCT          = config.get_float("W_FVG_PCT", 100.0)           # SMC fair-value gap


def _w(raw, filter_pct):
    """A filter's confidence delta scaled by its per-filter weight % and the global
    SIGNAL_WEIGHT_PCT. At 100/100 this returns `raw` unchanged (today's behaviour)."""
    return raw * (filter_pct / 100.0) * (SIGNAL_WEIGHT_PCT / 100.0)



def get_timeframe_params(timeframe):
    """
    Returns optimized parameters for each timeframe
    """
    params = {
        'lookback': 500,
        'bandwidth': 6.0,
        'multiplier': 3.0,
        'rsi_period': 14,
        'ma_period': 200,
        'confirmation_timeframe': '15m',
        'max_positions': 3,
        'risk_per_trade': 0.02,
        'stop_distance': 0.025,  # 2.5%
        'target_1_pct': 0.03,    # 3%
        'target_2_pct': 0.05,    # 5%
        'target_3_pct': 0.07,    # 7%
        'filters': ['volume', 'ma', 'confirmation']
    }

    # Short-term timeframes (scalping/day trading)
    if timeframe in ['1m', '5m', '15m']:
        params.update({
            'lookback': 200,
            'bandwidth': 3.5,
            'multiplier': 2.0,
            'rsi_period': 8,
            'ma_period': 50,
            'confirmation_timeframe': '1h',
            'max_positions': 8,
            'risk_per_trade': 0.01,
            'stop_distance': 0.015,  # 1.5%
            'target_1_pct': 0.015,   # 1.5%
            'target_2_pct': 0.025,   # 2.5%
            'target_3_pct': 0.04,    # 4%
        })

    # Medium-term timeframes (day trading)
    elif timeframe in ['30m', '1h']:
        params.update({
            'lookback': 300 if timeframe == '30m' else 500,
            'bandwidth': 4.5 if timeframe == '30m' else 6.0,
            'multiplier': 2.5 if timeframe == '30m' else 3.0,
            'rsi_period': 10 if timeframe == '30m' else 14,
            'ma_period': 100 if timeframe == '30m' else 200,
            'confirmation_timeframe': '1h' if timeframe == '30m' else '4h',  # 1h scan confirms against 4h
            'max_positions': 5 if timeframe == '30m' else 3,
            'risk_per_trade': 0.015 if timeframe == '30m' else 0.02,
            'stop_distance': 0.02 if timeframe == '30m' else 0.025,
            'target_1_pct': 0.02 if timeframe == '30m' else 0.03,
            'target_2_pct': 0.035 if timeframe == '30m' else 0.05,
            'target_3_pct': 0.05 if timeframe == '30m' else 0.07,
        })

    # Long-term timeframes (swing/position trading)
    elif timeframe in ['2h', '4h', '6h', '12h', '1d']:
        params.update({
            'lookback': 500,
            'bandwidth': 7.0 if timeframe in ['4h', '6h'] else 8.0,
            'multiplier': 3.5 if timeframe in ['4h', '6h'] else 4.0,
            'rsi_period': 14,
            'ma_period': 200,
            'confirmation_timeframe': '1h',
            'max_positions': 3,
            'risk_per_trade': 0.02,
            'stop_distance': 0.03,   # 3%
            'target_1_pct': 0.04,    # 4%
            'target_2_pct': 0.07,    # 7%
            'target_3_pct': 0.10,    # 10%
        })

    # --- .env override layer (per-scanner via SCANNER_ROLE) -------------------------
    # Tune the resolved shape knobs for whatever timeframe this scanner runs, without
    # enumerating the full TF matrix. Unset keys keep the base value above, so this is
    # behaviour-preserving by default. e.g. CRYPTO_BANDWIDTH=5.0, METALS_STOP_DISTANCE=0.02.
    # (max_positions / risk_per_trade are bot-level settings, handled separately.)
    params['lookback']       = config.get_int("LOOKBACK", params['lookback'])
    params['bandwidth']      = config.get_float("BANDWIDTH", params['bandwidth'])
    params['multiplier']     = config.get_float("MULTIPLIER", params['multiplier'])
    params['rsi_period']     = config.get_int("RSI_PERIOD", params['rsi_period'])
    params['ma_period']      = config.get_int("MA_PERIOD", params['ma_period'])
    params['confirmation_timeframe'] = config.get_str("CONFIRMATION_TIMEFRAME", params['confirmation_timeframe'])
    params['stop_distance']  = config.get_float("STOP_DISTANCE", params['stop_distance'])
    params['target_1_pct']   = config.get_float("TARGET_1_PCT", params['target_1_pct'])
    params['target_2_pct']   = config.get_float("TARGET_2_PCT", params['target_2_pct'])
    params['target_3_pct']   = config.get_float("TARGET_3_PCT", params['target_3_pct'])

    return params


def calculate_position_size(price, stop_loss, confidence, account_size, risk_percent):
    base_risk = account_size * risk_percent
    confidence_multiplier = 0.5 + (confidence / 100) * 1.0
    adjusted_risk = base_risk * confidence_multiplier

    risk_per_unit = abs(price - stop_loss)
    position_size = adjusted_risk / risk_per_unit if risk_per_unit > 0 else 0
    position_value = position_size * price

    max_position_value = account_size * 0.5
    if position_value > max_position_value:
        position_size = max_position_value / price
        position_value = max_position_value

    min_position_value = 50
    if position_value < min_position_value:
        position_size = min_position_value / price
        position_value = min_position_value

    return {
        'size': round(position_size, 4),
        'value': round(position_value, 2),
        'risk_amount': round(adjusted_risk, 2),
        'risk_percent': round((adjusted_risk / account_size) * 100, 2),
        'confidence_multiplier': round(confidence_multiplier, 2)
    }


def calculate_entry_exit(price, lower, upper, mid, signal_type, confidence, rsi_val, params, rsi_1h=None, atr_pct=None):
    result = {
        'entry': price,
        'stop_loss': None,
        'take_profit_1': None,
        'take_profit_2': None,
        'take_profit_3': None,
        'target_1_gain': None,
        'target_2_gain': None,
        'target_3_gain': None,
        'risk_reward_1': None,
        'risk_reward_2': None,
        'risk_reward_3': None
    }

    stop_distance = params['stop_distance']
    tp1_pct = params['target_1_pct']
    tp2_pct = params['target_2_pct']
    tp3_pct = params['target_3_pct']

    entry_adjustment = 0

    if rsi_1h is not None:
        if signal_type.startswith('SELL') and rsi_1h < 30:
            adjustment_pct = ((30 - rsi_1h) / 30) * 0.02
            entry_adjustment = price * adjustment_pct
        elif signal_type.startswith('BUY') and rsi_1h > 70:
            adjustment_pct = ((rsi_1h - 70) / 30) * 0.02
            entry_adjustment = -price * adjustment_pct

    adjusted_entry = price + entry_adjustment

    if signal_type.startswith('BUY'):
        entry = max(adjusted_entry, lower * 1.005)
        result['entry'] = round(entry, 4)

        if USE_ATR_LEVELS and atr_pct:
            atr_abs = atr_pct / 100 * entry
            stop_dist = min(max(ATR_STOP_MULT * atr_abs, ATR_STOP_MIN_FRAC_OF_PCT * stop_distance * entry),
                            ATR_STOP_MAX_FRAC_OF_PCT * stop_distance * entry)
            stop = entry - stop_dist
            tp1 = entry + ATR_TP1_MULT * atr_abs
            if mid and mid > entry:
                tp1 = min(tp1, mid)          # never target past the mean → "not too far"
            tp2 = entry + ATR_TP2_MULT * atr_abs
            tp3 = entry + ATR_TP3_MULT * atr_abs
        else:
            stop = min(price * (1 - stop_distance), lower * (1 - stop_distance * 0.4))
            tp1 = min(mid, entry * (1 + tp1_pct * 0.5))
            if tp1 <= entry:
                tp1 = entry * (1 + tp1_pct * 0.5)
            # Pull TP1 toward entry for a more-probable fill (see TP1_TIGHTEN_FACTOR).
            tp1 = entry + TP1_TIGHTEN_FACTOR * (tp1 - entry)
            tp2 = entry * (1 + tp1_pct + (confidence / 100) * tp1_pct * 0.5)
            tp3 = entry * (1 + tp2_pct + (confidence / 100) * tp2_pct * 0.5)

        result['stop_loss'] = round(stop, 4)
        result['take_profit_1'] = round(tp1, 4)
        result['take_profit_2'] = round(tp2, 4)
        result['take_profit_3'] = round(tp3, 4)

        risk = entry - stop
        if risk > 0:
            result['target_1_gain'] = round((tp1 - entry) / entry * 100, 2)
            result['target_2_gain'] = round((tp2 - entry) / entry * 100, 2)
            result['target_3_gain'] = round((tp3 - entry) / entry * 100, 2)
            result['risk_reward_1'] = round((tp1 - entry) / risk, 2)
            result['risk_reward_2'] = round((tp2 - entry) / risk, 2)
            result['risk_reward_3'] = round((tp3 - entry) / risk, 2)

    elif signal_type.startswith('SELL'):
        entry = min(adjusted_entry, upper * 0.995)
        result['entry'] = round(entry, 4)

        if USE_ATR_LEVELS and atr_pct:
            atr_abs = atr_pct / 100 * entry
            stop_dist = min(max(ATR_STOP_MULT * atr_abs, ATR_STOP_MIN_FRAC_OF_PCT * stop_distance * entry),
                            ATR_STOP_MAX_FRAC_OF_PCT * stop_distance * entry)
            stop = entry + stop_dist
            tp1 = entry - ATR_TP1_MULT * atr_abs
            if mid and mid < entry:
                tp1 = max(tp1, mid)          # never target past the mean → "not too far"
            tp2 = entry - ATR_TP2_MULT * atr_abs
            tp3 = entry - ATR_TP3_MULT * atr_abs
        else:
            stop = max(price * (1 + stop_distance), upper * (1 + stop_distance * 0.4))
            tp1 = max(mid, entry * (1 - tp1_pct * 0.5))
            if tp1 >= entry:
                tp1 = entry * (1 - tp1_pct * 0.5)
            # Pull TP1 toward entry for a more-probable fill (see TP1_TIGHTEN_FACTOR).
            tp1 = entry + TP1_TIGHTEN_FACTOR * (tp1 - entry)
            tp2 = entry * (1 - tp1_pct - (confidence / 100) * tp1_pct * 0.5)
            tp3 = entry * (1 - tp2_pct - (confidence / 100) * tp2_pct * 0.5)

        result['stop_loss'] = round(stop, 4)
        result['take_profit_1'] = round(tp1, 4)
        result['take_profit_2'] = round(tp2, 4)
        result['take_profit_3'] = round(tp3, 4)

        risk = stop - entry
        if risk > 0:
            result['target_1_gain'] = round((entry - tp1) / entry * 100, 2)
            result['target_2_gain'] = round((entry - tp2) / entry * 100, 2)
            result['target_3_gain'] = round((entry - tp3) / entry * 100, 2)
            result['risk_reward_1'] = round((entry - tp1) / risk, 2)
            result['risk_reward_2'] = round((entry - tp2) / risk, 2)
            result['risk_reward_3'] = round((entry - tp3) / risk, 2)

    return result


# ============================================
# SIGNAL DETECTION  (shared mean-reversion detector)
# ============================================
# Ported from scanner.py verbatim, then parameterised: the higher-timeframe RSI
# confirmation is injected (confirm_fn — data-source specific), and the BTC-regime
# tail is injected as two optional hooks (regime_adjust before the 0-100 clamp,
# regime_gate after). scanner.py supplies both hooks; metals-scanner.py passes neither.
def detect_signals(price, high, low, volume, rsi_val, lower, upper, mid, symbol, params, use_squeeze=True, use_smre=True, use_smc=True, confirm_fn=None, regime_adjust=None, regime_gate=None):
    current = price[-1]
    prev = price[-2]
    signals = []
    
    rsi_period = params['rsi_period']
    ma_period = params['ma_period']
    confirm_tf = params['confirmation_timeframe']
    
    # --- CALCULATE SQUEEZE MOMENTUM ---
    squeeze_on, momentum, squeeze_release = squeeze_momentum(high, low, price)
    
    # --- CALCULATE SMRE FILTERS ---
    is_mean_reverting, z_score, smre_confidence = smre_filter(price)
    is_stationary, hurst = stationarity_test(price)
    vol_regime, vol_score = volatility_regime(price)
    
    # --- CALCULATE SMC ---
    structure, trend, swing_high, swing_low = detect_market_structure(high, low, price)
    ob_high, ob_low, ob_direction = find_order_block(high, low, price)
    fvg_high, fvg_low, fvg_direction = find_fair_value_gap(high, low)
    
    # 1. CROSSOVER SIGNAL
    # RSI slope deliberately flattened (was *2, cap 85): a steeper curve pushed
    # confidence UP as RSI got more extreme — backwards, since extreme RSI is where
    # fades fail. RSI now contributes less; the continuation guard (below) handles tails.
    if current > lower and prev <= lower and rsi_val < 45:
        base_confidence = min(80, (45 - rsi_val) * 1.2 + 45)
        signals.append({
            'type': 'BUY_CROSS',
            'base_confidence': base_confidence,
            'description': 'Bullish cross above lower band'
        })

    if current < upper and prev >= upper and rsi_val > 55:
        base_confidence = min(80, (rsi_val - 55) * 1.2 + 45)
        signals.append({
            'type': 'SELL_CROSS',
            'base_confidence': base_confidence,
            'description': 'Bearish cross below upper band'
        })

    # 2. OVERSOLD/OVERBOUGHT BOUNCE
    if rsi_val < 35 and current < lower * 1.03:
        base_confidence = min(72, (35 - rsi_val) * 1.5 + 35)
        signals.append({
            'type': 'BUY_OVERSOLD',
            'base_confidence': base_confidence,
            'description': f'Oversold (RSI {rsi_val:.1f}) near lower band'
        })

    if rsi_val > 65 and current > upper * 0.97:
        base_confidence = min(72, (rsi_val - 65) * 1.5 + 35)
        signals.append({
            'type': 'SELL_OVERBOUGHT',
            'base_confidence': base_confidence,
            'description': f'Overbought (RSI {rsi_val:.1f}) near upper band'
        })
    
    # 3. ENVELOPE EXTREME
    # Fix #5: renamed variable to upper_excess (negative = price above upper band).
    # Fix #6: signal types now carry BUY_/SELL_ prefix so they reach display and
    #         all startswith('BUY') / startswith('SELL') filter branches below.
    if lower is not None and lower > 0:
        lower_dist = ((current - lower) / current) * 100  # negative = below lower
        if lower_dist < -2:
            signals.append({
                'type': 'BUY_EXTREME_OVERSOLD',
                'base_confidence': 60,
                'description': f'Price {abs(lower_dist):.1f}% below lower band'
            })

    if upper is not None and upper > 0:
        upper_excess = ((upper - current) / current) * 100  # negative = above upper
        if upper_excess < -2:
            signals.append({
                'type': 'SELL_EXTREME_OVERBOUGHT',
                'base_confidence': 60,
                'description': f'Price {abs(upper_excess):.1f}% above upper band'
            })
    
    # ============================================
    # FETCH HIGHER TIMEFRAME RSI
    # ============================================
    # Fix #7: derive direction from the first candidate signal so SELL signals
    # check overbought on the higher TF, not oversold (the old behaviour).
    first_direction = 'BUY' if (signals and signals[0]['type'].startswith('BUY')) else 'SELL'
    confirms_1h, rsi_1h = confirm_fn(
        symbol, confirm_tf, rsi_period,
        signal_direction=first_direction,
        rsi_threshold=42
    )
    
    # APPLY FILTERS
    enhanced_signals = []
    for signal in signals:
        confidence = signal['base_confidence']
        filters_triggered = []
        skip_signal = False
        is_sell = signal['type'].startswith('SELL')

        # ============================================
        # FILTER 0: ANTI-BREAKOUT GUARDS (July-4 post-mortem)
        # ============================================
        # #3 RSI continuation: past the reversion zone, extreme RSI means momentum, not a
        # top. Penalise the fade, then veto it outright at the extreme.
        rsi_pen, rsi_veto = guards.rsi_continuation_penalty(rsi_val, is_sell)
        if rsi_veto:
            skip_signal = True
            filters_triggered.append(f"⛔ RSI {rsi_val:.0f} extreme — {signal['type']} fades momentum")
        elif rsi_pen:
            confidence -= rsi_pen
            filters_triggered.append(f"⚠️ RSI {rsi_val:.0f} stretched — fade -{rsi_pen:.0f}")

        # #2 Adverse impulse: don't fade a move already running against us (a breakout).
        imp_atr = guards.adverse_impulse_atr(price, high, low, is_sell)
        if imp_atr >= guards.FADE_IMPULSE_VETO_ATR:
            skip_signal = True
            filters_triggered.append(f"⛔ Fading a {imp_atr:.1f}-ATR impulse — breakout, not a top")
        elif imp_atr >= guards.FADE_IMPULSE_PENALTY_ATR:
            imp_pen = (imp_atr - guards.FADE_IMPULSE_PENALTY_ATR) * guards.FADE_IMPULSE_PENALTY_PER_ATR
            confidence -= imp_pen
            filters_triggered.append(f"⚠️ Adverse impulse {imp_atr:.1f} ATR — fade -{imp_pen:.0f}")

        # #5 Volatility spike (non-directional): don't fade into a violent bar.
        vol_atr = guards.volatility_spike_atr(high, low, price)
        if vol_atr >= guards.VOL_SPIKE_VETO_ATR:
            skip_signal = True
            filters_triggered.append(f"⛔ Volatility spike {vol_atr:.1f}× ATR — reversion unreliable")
        elif vol_atr >= guards.VOL_SPIKE_PENALTY_ATR:
            vol_pen = (vol_atr - guards.VOL_SPIKE_PENALTY_ATR) * guards.VOL_SPIKE_PENALTY_PER_ATR
            confidence -= vol_pen
            filters_triggered.append(f"⚠️ Volatility spike {vol_atr:.1f}× ATR — fade -{vol_pen:.0f}")

        # FILTER 1: Volume Analysis
        if len(volume) > 15:
            avg_volume = np.mean(volume[-15:])
            current_volume = volume[-1]
            volume_ratio = current_volume / avg_volume if avg_volume > 0 else 1
            
            price_change = (current - price[-5]) / price[-5] * 100 if len(price) > 5 else 0
            
            if volume_ratio > 1.8:
                if signal['type'].startswith('BUY'):
                    if price_change < -2:
                        confidence -= _w(25, W_VOLUME_PCT)
                        filters_triggered.append(f"⚠️ High volume {volume_ratio:.1f}x on down move")
                        if confidence < 30:
                            skip_signal = True
                    else:
                        confidence += _w(12, W_VOLUME_PCT)
                        filters_triggered.append(f"🔥 Volume {volume_ratio:.1f}x avg")
                elif signal['type'].startswith('SELL'):
                    if price_change > 2:
                        confidence -= _w(25, W_VOLUME_PCT)
                        filters_triggered.append(f"⚠️ High volume {volume_ratio:.1f}x on up move")
                        if confidence < 30:
                            skip_signal = True
                    else:
                        confidence += _w(12, W_VOLUME_PCT)
                        filters_triggered.append(f"🔥 Volume {volume_ratio:.1f}x avg")
            elif volume_ratio > 1.3:
                confidence += _w(6, W_VOLUME_PCT)
                filters_triggered.append(f"📈 Volume {volume_ratio:.1f}x avg")
            else:
                filters_triggered.append(f"📉 Volume {volume_ratio:.1f}x avg")
        
        # FILTER 2: MA Trend Alignment
        if len(price) > ma_period:
            ma = np.mean(price[-ma_period:])
            
            if signal['type'].startswith('BUY'):
                if current > ma:
                    confidence += _w(8, W_MA_PCT)
                    filters_triggered.append(f"✅ Above MA{ma_period} (${ma:.2f})")
                else:
                    confidence -= _w(15, W_MA_PCT)
                    filters_triggered.append(f"⚠️ Below MA{ma_period} (${ma:.2f})")
                    if current < ma * 0.98:
                        confidence -= _w(10, W_MA_PCT)
                        filters_triggered.append(f"⚠️ Far below MA{ma_period}")
            
            elif signal['type'].startswith('SELL'):
                if current < ma:
                    confidence += _w(8, W_MA_PCT)
                    filters_triggered.append(f"✅ Below MA{ma_period} (${ma:.2f})")
                else:
                    confidence -= _w(15, W_MA_PCT)
                    filters_triggered.append(f"⚠️ Above MA{ma_period} (${ma:.2f})")
                    if current > ma * 1.02:
                        confidence -= _w(10, W_MA_PCT)
                        filters_triggered.append(f"⚠️ Far above MA{ma_period}")
        
        # FILTER 3: Timeframe Confirmation
        if confirms_1h is not None:
            if confirms_1h:
                confidence += _w(15, W_HTF_PCT)
                filters_triggered.append(f"✅ {confirm_tf} confirms (RSI {rsi_1h})")
            else:
                confidence -= _w(15, W_HTF_PCT)
                filters_triggered.append(f"⚠️ {confirm_tf} not confirming (RSI {rsi_1h})")
                if signal['type'].startswith('BUY') and rsi_1h > 45:
                    confidence -= _w(10, W_HTF_PCT)
                elif signal['type'].startswith('SELL') and rsi_1h < 55:
                    confidence -= _w(10, W_HTF_PCT)
        
        # FILTER 4: RSI Divergence Check
        if len(price) > 20:
            if signal['type'].startswith('BUY') and rsi_val < 30 and current > upper:
                confidence -= _w(20, W_DIVERGENCE_PCT)
                filters_triggered.append("⚠️ RSI/Price divergence")
            
            if signal['type'].startswith('SELL') and rsi_val > 70 and current < lower:
                confidence -= _w(20, W_DIVERGENCE_PCT)
                filters_triggered.append("⚠️ RSI/Price divergence")
        
        # FILTER 5: Price Change Velocity
        if len(price) > 10:
            recent_change = (current / price[-10] - 1) * 100
            if signal['type'].startswith('BUY') and recent_change < -10:
                confidence -= _w(15, W_VELOCITY_PCT)
                filters_triggered.append(f"⚠️ Sharp drop {recent_change:.1f}%")
            elif signal['type'].startswith('SELL') and recent_change > 10:
                confidence -= _w(15, W_VELOCITY_PCT)
                filters_triggered.append(f"⚠️ Sharp rise {recent_change:.1f}%")
        
        # ============================================
        # FILTER 6: HIGHER TIMEFRAME OVERRULE
        # ============================================
        if rsi_1h is not None:
            if signal['type'].startswith('SELL'):
                if rsi_1h < 30:
                    confidence -= _w(30, W_HTF_OVERRULE_PCT)
                    filters_triggered.append(f"⚠️ CRITICAL: 1h RSI {rsi_1h} < 30 (oversold) - SELL downgraded")
                    if rsi_1h < 20:
                        confidence -= _w(10, W_HTF_OVERRULE_PCT)
                        filters_triggered.append(f"⚠️ EXTREME: 1h RSI {rsi_1h} < 20 - SELL likely false")
                    if confidence < 40:
                        skip_signal = True
                        filters_triggered.append("❌ Signal skipped - 1h oversold contradicts SELL")
                elif rsi_1h < 40:
                    confidence -= _w(15, W_HTF_OVERRULE_PCT)
                    filters_triggered.append(f"⚠️ 1h RSI {rsi_1h} (oversold) - reduce confidence")
            
            elif signal['type'].startswith('BUY'):
                if rsi_1h > 70:
                    confidence -= _w(30, W_HTF_OVERRULE_PCT)
                    filters_triggered.append(f"⚠️ CRITICAL: 1h RSI {rsi_1h} > 70 (overbought) - BUY downgraded")
                    if rsi_1h > 80:
                        confidence -= _w(10, W_HTF_OVERRULE_PCT)
                        filters_triggered.append(f"⚠️ EXTREME: 1h RSI {rsi_1h} > 80 - BUY likely false")
                    if confidence < 40:
                        skip_signal = True
                        filters_triggered.append("❌ Signal skipped - 1h overbought contradicts BUY")
                elif rsi_1h > 60:
                    confidence -= _w(15, W_HTF_OVERRULE_PCT)
                    filters_triggered.append(f"⚠️ 1h RSI {rsi_1h} (overbought) - reduce confidence")
        
        # ============================================
        # FILTER 7: SQUEEZE MOMENTUM
        # ============================================
        if use_squeeze:
            if signal['type'].startswith('BUY'):
                if squeeze_release and current > upper:
                    confidence += _w(15, W_SQUEEZE_PCT)
                    filters_triggered.append(f"🔥 SQUEEZE RELEASE (upside)")
                elif squeeze_on:
                    filters_triggered.append(f"📊 Squeeze active - waiting for release")
                else:
                    confidence -= _w(5, W_SQUEEZE_PCT)
                    filters_triggered.append(f"⚠️ No squeeze momentum")
            elif signal['type'].startswith('SELL'):
                if squeeze_release and current < lower:
                    confidence += _w(15, W_SQUEEZE_PCT)
                    filters_triggered.append(f"🔥 SQUEEZE RELEASE (downside)")
                elif squeeze_on:
                    filters_triggered.append(f"📊 Squeeze active - waiting for release")
                else:
                    confidence -= _w(5, W_SQUEEZE_PCT)
                    filters_triggered.append(f"⚠️ No squeeze momentum")
        
        # ============================================
        # FILTER 8: SMRE STATISTICAL FILTERS
        # ============================================
        if use_smre:
            if not is_mean_reverting:
                confidence -= _w(10, W_SMRE_PCT)
                filters_triggered.append(f"⚠️ Z-score {z_score:.2f} (not extreme)")
            else:
                confidence += _w(smre_confidence * 0.1, W_SMRE_PCT)
                filters_triggered.append(f"✅ Z-score {z_score:.2f} (extreme)")
            
            if is_stationary:
                confidence += _w(8, W_SMRE_PCT)
                filters_triggered.append(f"✅ Stationary (Hurst {hurst:.2f})")
            else:
                confidence -= _w(8, W_SMRE_PCT)
                filters_triggered.append(f"⚠️ Non-stationary (Hurst {hurst:.2f})")
            
            if vol_regime == 'low':
                confidence += _w(5, W_SMRE_PCT)
                filters_triggered.append(f"✅ Low volatility ({vol_score:.0f}%)")
            elif vol_regime == 'high':
                confidence -= _w(10, W_SMRE_PCT)
                filters_triggered.append(f"⚠️ High volatility ({vol_score:.0f}%) - reduce size")
        
        # ============================================
        # FILTER 9: SMART MONEY CONCEPTS (SMC)
        # ============================================
        if use_smc:
            # Market Structure Filter
            if signal['type'].startswith('BUY'):
                if trend == 'bullish':
                    confidence += _w(10, W_STRUCTURE_PCT)
                    filters_triggered.append(f"✅ Bullish structure (BOS UP)")
                elif trend == 'bearish':
                    confidence -= _w(15, W_STRUCTURE_PCT)
                    filters_triggered.append(f"⚠️ Bearish structure (BOS DOWN) - BUY against trend")
                else:
                    filters_triggered.append(f"⚪ Neutral structure")
            elif signal['type'].startswith('SELL'):
                if trend == 'bearish':
                    confidence += _w(10, W_STRUCTURE_PCT)
                    filters_triggered.append(f"✅ Bearish structure (BOS DOWN)")
                elif trend == 'bullish':
                    confidence -= _w(15, W_STRUCTURE_PCT)
                    filters_triggered.append(f"⚠️ Bullish structure (BOS UP) - SELL against trend")
                else:
                    filters_triggered.append(f"⚪ Neutral structure")
            
            # Order Block Filter
            try:
                if ob_high is not None and ob_low is not None:
                    ob_high_val = float(ob_high)
                    ob_low_val = float(ob_low)
                    if signal['type'].startswith('BUY'):
                        if current >= ob_low_val and current <= ob_high_val * 1.02:
                            confidence += _w(8, W_OB_PCT)
                            filters_triggered.append(f"✅ In Order Block zone (${ob_low_val:.2f}-${ob_high_val:.2f})")
                    elif signal['type'].startswith('SELL'):
                        if current >= ob_low_val and current <= ob_high_val:
                            confidence += _w(8, W_OB_PCT)
                            filters_triggered.append(f"✅ In Order Block zone (${ob_low_val:.2f}-${ob_high_val:.2f})")
                else:
                    filters_triggered.append(f"⚠️ No Order Block detected")
            except (TypeError, ValueError):
                pass
            
            # Fair Value Gap Filter
            try:
                if fvg_high is not None and fvg_low is not None:
                    fvg_high_val = float(fvg_high)
                    fvg_low_val = float(fvg_low)
                    if signal['type'].startswith('BUY') and fvg_direction == 'bullish':
                        if current >= fvg_low_val and current <= fvg_high_val:
                            confidence += _w(10, W_FVG_PCT)
                            filters_triggered.append(f"✅ In FVG zone (${fvg_low_val:.2f}-${fvg_high_val:.2f})")
                    elif signal['type'].startswith('SELL') and fvg_direction == 'bearish':
                        if current >= fvg_low_val and current <= fvg_high_val:
                            confidence += _w(10, W_FVG_PCT)
                            filters_triggered.append(f"✅ In FVG zone (${fvg_low_val:.2f}-${fvg_high_val:.2f})")
                else:
                    filters_triggered.append(f"⚠️ No FVG detected")
            except (TypeError, ValueError):
                pass
        
        # ============================================
        # FINAL CONFIDENCE CALCULATION
        # ============================================
        # BTC macro-regime confidence adjustment (crypto only; injected — metals pass None).
        if regime_adjust is not None:
            confidence, _rmsgs = regime_adjust(signal['type'], symbol, confidence)
            filters_triggered.extend(_rmsgs)

        confidence = max(0, min(100, confidence))

        # Hard regime block + BTC volatility circuit breaker (crypto only; injected).
        if regime_gate is not None:
            _gate_skip, _rmsgs = regime_gate(signal['type'], symbol, confidence)
            filters_triggered.extend(_rmsgs)
            if _gate_skip:
                skip_signal = True

        if confidence < 50:
            skip_signal = True
        
        if not skip_signal:
            enhanced_signals.append({
                'type': signal['type'],
                'confidence': round(confidence, 1),
                'description': signal['description'],
                'filters': filters_triggered,
                'base_confidence': signal['base_confidence'],
                'rsi_1h': rsi_1h,
                'squeeze_on': squeeze_on,
                'squeeze_release': squeeze_release,
                'z_score': round(z_score, 2),
                'hurst': hurst,
                'vol_regime': vol_regime,
                'smc_trend': trend,
                'smc_structure': structure,
                'ob_high': ob_high,
                'ob_low': ob_low,
                'fvg_high': fvg_high,
                'fvg_low': fvg_low
            })
    
    enhanced_signals.sort(key=lambda x: x['confidence'], reverse=True)
    return enhanced_signals
