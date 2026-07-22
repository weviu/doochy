import { state, Position, symbolIdFor } from "../state";
import { canValueInUsd } from "../ctrader/livePrices";
import { ParsedSignal } from "../signals/types";
import { isLocked, evaluateDailyLimits } from "./dailyLoss";
import { getCooldown } from "./cooldown";
import { getReentryCooldown, formatRemaining } from "./reentryCooldown";
import { existingCombinedRisk } from "./combinedRisk";
import { executeSignal } from "../ctrader/orders";
import { executeReversal } from "./reversal";
import { maybeNotifySignal } from "../bot/signalNotify";
import { inEntryBlackout } from "./news/calendar";
import { effectiveTimeExitMin } from "./timeExit";
import { recordSignal } from "../signals/history";

// Outcome of running a signal through the gate. The poller ignores this; the
// webhook uses it to tell the caller whether the signal executed or why it was
// rejected. Gate logic and logging below are unchanged.
export interface GateResult {
  accepted: boolean;
  reason?: string;
}

// Public entry: run the gate and record the signal + its outcome to the history
// log (display-only) before returning. Every caller (feed poller, channel relay)
// goes through here, so the log captures both.
export function processSignal(signal: ParsedSignal): GateResult {
  const result = gateSignal(signal);
  recordSignal(signal, result);
  return result;
}

function gateSignal(signal: ParsedSignal): GateResult {
  // Signal notification (independent of execution): tell the user about every
  // qualifying signal up front, before any gate rejection, so they can trade it
  // manually elsewhere even when this account skips it.
  maybeNotifySignal(signal);

  // Check 1: Trading paused?
  if (state.paused) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Trading paused`);
    return { accepted: false, reason: "Trading paused" };
  }

  // Check 1a: SL is always mandatory (it sets the risk-based position size). TP is
  // normally mandatory too (it's the exit), EXCEPT for an in-scope time-exit signal:
  // the gold time-based strategy manages on SL + timer and may carry a null TP, so
  // the timer is the exit and no TP is required. A missing SL, or a missing TP on a
  // non-timed signal, means a malformed/incomplete signal and is rejected.
  const timeExit = effectiveTimeExitMin(signal.symbol, signal.signalSource, signal.timeExitMin);
  if (signal.sl == null || (signal.tp == null && timeExit <= 0)) {
    const needTp = signal.tp == null && timeExit <= 0;
    const reason = `Missing ${signal.sl == null ? "SL" : ""}${signal.sl == null && needTp ? " and " : ""}${needTp ? "TP" : ""}`;
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
    return { accepted: false, reason };
  }

  // Check 1b: Re-entry cooldown after a loss (prop-firm same-trade-idea rule).
  // A losing close blocks re-entry on the SAME symbol+direction for a window.
  // Checked early so blocked signals are rejected quickly. Opposite direction
  // and wins are unaffected.
  const reentryMs = getReentryCooldown(signal.symbol, signal.direction);
  if (reentryMs !== null) {
    const reason = `Cooldown active: ${formatRemaining(reentryMs)} remaining`;
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
    return { accepted: false, reason };
  }

  // Check 1c: Combined per-trade-idea risk (prop-firm limit). Sum the potential
  // loss of all open positions of the same symbol+direction; if adding this
  // signal would push the total over the limit, reject. The new signal will be
  // sized to ~riskPerTradeUSD, so that is its estimated risk. Opposite direction
  // is a separate trade idea. Skipped when the limit is 0.
  const maxCombined = state.settings.maxCombinedRiskUSD;
  if (maxCombined > 0) {
    const newRisk = state.settings.riskPerTradeUSD;
    const { existingSum, positions } = existingCombinedRisk(signal.symbol, signal.direction, newRisk);
    const wouldBe = existingSum + newRisk;
    if (wouldBe > maxCombined) {
      const reason = `Combined risk limit exceeded: existing $${existingSum.toFixed(2)} + new $${newRisk.toFixed(2)} = $${wouldBe.toFixed(2)} (max $${maxCombined})`;
      console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
      const perPos = positions.map((p, i) => `pos${i + 1} $${p.potentialLoss.toFixed(2)}${p.hasSL ? "" : " (no SL, est)"}`).join(", ") || "none";
      console.log(`[GATE]   combined-risk breakdown: [${perPos}], total existing $${existingSum.toFixed(2)}, new $${newRisk.toFixed(2)}, would-be $${wouldBe.toFixed(2)} (max $${maxCombined})`);
      return { accepted: false, reason };
    }
  }

  // Check 2: Symbol on the allowed list?
  if (!state.settings.allowedSymbols.includes(signal.symbol)) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Not in allowed symbols`);
    return { accepted: false, reason: "Not in allowed symbols" };
  }

  // Check 2b: Symbol available on this broker?
  const resolvable = symbolIdFor(signal.symbol) !== undefined;
  if (!resolvable) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Not available on broker`);
    return { accepted: false, reason: "Not available on broker" };
  }

  // Check 2b2: The symbol must be valuable in USD. USD-quoted symbols qualify
  // directly; a non-USD-quoted pair (e.g. JPY-quoted GBPJPY, CAD-quoted USDCAD)
  // qualifies only if the broker offers a USD conversion pair for its quote
  // currency, which lets quoteToUsd convert its P&L/risk into real dollars. A symbol
  // with no USD conversion path would be mis-read by ~the cross rate, so refuse it.
  // (Whether the conversion rate has actually streamed yet is enforced later, at
  // sizing time, which refuses the trade if the rate is momentarily unavailable.)
  if (!canValueInUsd(signal.symbol)) {
    const reason = `${signal.symbol} cannot be valued in USD (no conversion pair); doochybot skips it. Remove it with /symbols remove ${signal.symbol}`;
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
    return { accepted: false, reason };
  }

  // Check 2c: Minimum confidence (entry gate). Reject feed signals scoring below
  // the threshold (RSI alone, no confirmation). Channel signals carry the channel
  // confidence and bypass this entirely - they are analyst-curated, not
  // algorithmic scores. 0 disables the gate.
  const minConf = state.settings.minConfidence;
  const conf = signal.confidence ?? 0;
  if (minConf > 0 && conf < minConf && conf < state.settings.webhookConfidence) {
    const reason = `Confidence too low (${conf}, minimum ${minConf})`;
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
    return { accepted: false, reason };
  }

  // Check 2d: BTC macro-bias gate (crypto BUYs only). Crypto tracks BTC, so when
  // BTC's higher-timeframe state is bearish we only let high-conviction LONGS
  // through. The feed stamps each alert with btc_state (signal.btcState): one of
  // the five states for crypto, or null for non-crypto (gold, silver, forex,
  // indices) - the scanner already classified those, so a null/absent state skips
  // this gate entirely. SELLs are aligned with the bearishness and pass untouched.
  if (state.settings.btcBiasGate && signal.direction === "BUY" && signal.btcState) {
    let floor: number | null = null;
    if (signal.btcState === "BEARISH_STRONG") floor = state.settings.btcBiasMinConfStrongBearish;
    else if (signal.btcState === "BEARISH") floor = state.settings.btcBiasMinConfBearish;
    const conf = signal.confidence ?? 0;
    if (floor !== null && conf < floor) {
      const reason = `BTC ${signal.btcState}: BUY needs confidence >= ${floor} (got ${conf})`;
      console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - ${reason}`);
      return { accepted: false, reason };
    }
  }

  // Check 2e: Scheduled-news blackout (gold today). Do not OPEN a new in-scope
  // position within the blackout window of a USD/High economic release - gold
  // flash-moves through the stop on those prints, and on a $300/day prop account
  // one gap-through can breach the day. Scoped to in-scope symbol + signal_source
  // (XAUUSD + gold_scanner by default); everything else passes untouched. Placed
  // before the reversal logic so a gold reversal isn't closed-then-left-flat by a
  // blocked re-open. The signal can re-fire and trade once the window clears
  // (event + postBlackoutMin). failClosed also blocks here on a stale calendar.
  const blackout = inEntryBlackout(Date.now(), signal.symbol, signal.signalSource);
  if (blackout.blocked) {
    console.log(`[news] blocked ${signal.symbol} ${signal.direction} entry - ${blackout.reason}`);
    return { accepted: false, reason: `News blackout: ${blackout.reason}` };
  }

  // Check 3: Per-symbol consecutive-loss cooldown.
  const cooldown = getCooldown(signal.symbol);
  if (cooldown) {
    const minsLeft = Math.ceil(cooldown.remainingMs / 60_000);
    const until = new Date(Date.now() + cooldown.remainingMs).toISOString().slice(11, 16);
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Cooldown after ${cooldown.hits} SL hits, ${minsLeft}m left (until ${until} UTC)`);
    return { accepted: false, reason: `Cooldown after ${cooldown.hits} SL hits, ${minsLeft}m left (until ${until} UTC)` };
  }

  // Check 4: One position per symbol. Runs before the max-positions check so a
  // valid reversal (which closes one and opens one — net zero) is never blocked
  // by being at the position cap.
  let existingId: number | null = null;
  let existing: Position | null = null;
  for (const [id, pos] of state.positions.entries()) {
    if (pos.symbol === signal.symbol) {
      existingId = id;
      existing = pos;
      break;
    }
  }

  if (existing && existingId !== null) {
    // Same direction — never stack duplicates.
    if (existing.direction === signal.direction) {
      console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} — Already holding ${existing.direction}`);
      return { accepted: false, reason: `Already holding ${existing.direction}` };
    }

    // Opposite direction: flip if the new signal is at least as confident. Equal
    // confidence flips because the newer signal is the source's updated view (a
    // channel reversing its own call sends equal-confidence signals, which the
    // old strictly-higher rule could never honour). The minimum-confidence gate
    // (Check 2c) already ran, so a weak signal never reaches here.
    const newConf = signal.confidence ?? 0;
    const oldConf = existing.confidence ?? 0;
    if (newConf < oldConf) {
      console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} — Confidence too low (${newConf} vs existing ${oldConf})`);
      return { accepted: false, reason: `Confidence too low (${newConf} vs existing ${oldConf})` };
    }

    console.log(`[GATE] Reversal: closing ${existing.direction} ${signal.symbol} (conf ${oldConf}) for ${signal.direction} (conf ${newConf})`);
    executeReversal(existingId, existing, signal).catch((err) => {
      console.log(`[REVERSAL] Unhandled error for ${signal.symbol}: ${err.message}`);
    });
    return { accepted: true, reason: "Reversal: flipped existing position" };
  }

  // Check 4b: An order for this symbol+direction is already placed but not yet
  // filled. The duplicate check (Check 7) only looks at executed signals, and
  // Check 4 only looks at open positions — neither sees an order still awaiting
  // fill. Without this, a signal that keeps re-arriving submits a fresh order
  // every cycle while the prior ones sit pending at the broker.
  for (const pending of state.pendingOrders.values()) {
    if (pending.symbol === signal.symbol && pending.direction === signal.direction) {
      console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} — Order already pending fill`);
      return { accepted: false, reason: "Order already pending fill" };
    }
  }

  // Check 5: Max positions reached?
  if (state.positions.size >= state.settings.maxPositions) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Max positions (${state.settings.maxPositions})`);
    return { accepted: false, reason: `Max positions (${state.settings.maxPositions})` };
  }

  // Check 6: Trading locked by a daily limit (loss limit or profit cap)?
  evaluateDailyLimits(true);
  if (isLocked()) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Daily limit reached (trading locked)`);
    return { accepted: false, reason: "Daily limit reached (trading locked)" };
  }

  // Check 7: Duplicate signal within 60s?
  const signalKey = `${signal.symbol}:${signal.direction}`;
  const lastTime = state.lastSignalTime.get(signalKey);
  const now = Date.now();
  if (lastTime && (now - lastTime) < 60_000) {
    console.log(`[GATE] Rejected: ${signal.direction} ${signal.symbol} - Duplicate within 60s`);
    return { accepted: false, reason: "Duplicate within 60s" };
  }

  state.lastSignalTime.set(signalKey, now);
  console.log(`[GATE] Passed: ${signal.direction} ${signal.symbol}`);
  executeSignal(signal).catch((err) => {
    console.log(`[ORDER] Unhandled error for ${signal.symbol}: ${err.message}`);
  });
  return { accepted: true };
}
