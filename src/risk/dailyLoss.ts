import { state, setTradingLock } from "../state";
import { notify } from "../bot/notify";
import { getMarkPrice, quoteToUsd, hasLiveQuote } from "../ctrader/livePrices";
import { clearCountedDeals } from "../ctrader/orders";

// The hard daily loss threshold in USD. Single source of truth, set via
// /risk maxloss. (The old percent-based limit was removed — it duplicated this
// and was computed off a hardcoded $10k balance, which was misleading.)
export function maxLossUSD(): number {
  return state.settings.maxDailyLossUSD;
}

// Sum of unrealized P&L (in USD) across all open positions. Uses the live cTrader
// spot price (authoritative, matches the broker's Net USD) and converts each
// position's quote-currency P&L into USD via quoteToUsd (1 for USD-quoted symbols,
// the live conversion-pair rate for JPY/CAD-quoted ones).
export function floatingPnL(): number {
  let total = 0;
  for (const pos of state.positions.values()) {
    if (!state.settings.allowedSymbols.includes(pos.symbol)) continue;
    // Convert the position's quote-currency P&L into USD. If no conversion rate is
    // available even from the cache (should not happen once the conversion pairs are
    // pre-subscribed at boot), skip this position rather than count a wrong figure
    // that could trip the daily-loss limit. Sizing already refuses trades with no
    // rate, so this is a defensive last resort, not the normal path.
    const factor = quoteToUsd(pos.symbol);
    if (factor === null) continue;
    const mark = getMarkPrice(pos.symbol, pos.direction);
    if (!mark || !pos.entryPrice) continue;
    const diff = pos.direction === "BUY" ? mark - pos.entryPrice : pos.entryPrice - mark;
    total += diff * (pos.volumeCents / 100) * factor;
  }
  return total;
}

// True only when every open (allowed) position has a live quote, so floatingPnL()
// is a COMPLETE sum. When false, floatingPnL() silently omits the unquoted
// positions, so any realized+floating decision built on it is untrustworthy.
function allPositionsQuoted(): boolean {
  for (const pos of state.positions.values()) {
    if (!state.settings.allowedSymbols.includes(pos.symbol)) continue;
    if (!hasLiveQuote(pos.symbol)) return false;
  }
  return true;
}

// If a daily limit is currently breached, return a human-readable reason for the
// lock; otherwise null. The profit cap uses realized + floating so an account
// already at +$390 realized won't open more positions while floating +$50.
//
// Floating is only trusted when EVERY open position has a live quote. Otherwise
// floatingPnL() omits the unquoted ones (understating a loser's loss, so the cap
// could false-trip; or a winner's gain, so the loss limit could false-trip), which
// is the same incomplete-data trap the cap/loss monitors guard against. When
// incomplete we fall back to a realized-only check: a realized-alone breach is
// unambiguous and still locks, but we never SET a lock on a floating figure we
// can't trust. The full realized+floating check resumes once quotes are complete.
function breachedLimit(): string | null {
  const complete = allPositionsQuoted();
  const floating = complete ? floatingPnL() : 0;
  const note = complete ? "" : " [realized only; awaiting quotes]";

  const cap = state.settings.dailyProfitCapUSD;
  if (cap > 0) {
    const total = state.dailyRealizedPnL + floating;
    if (total >= cap) {
      return `Daily profit cap reached: +${total.toFixed(2)} USD (cap ${cap.toFixed(2)})${note}`;
    }
  }
  const loss = maxLossUSD();
  const totalPnL = state.dailyRealizedPnL + floating;
  if (totalPnL < -loss) {
    return `Daily loss limit hit: ${totalPnL.toFixed(2)} USD (limit -${loss.toFixed(2)})${note}`;
  }
  return null;
}

// Re-check the daily limits against current realized P&L and lock trading if a
// limit is breached. Called after each close and once at boot. When `announce`
// is set, pushes a Telegram alert on the transition into a locked state.
export function evaluateDailyLimits(announce: boolean): void {
  // Never check limits against an unseeded counter — a failed seed leaves the
  // counter at 0, which would false-trigger the loss limit as soon as any
  // position closes at a loss within the session.
  if (!state.dailyPnLSeeded) {
    console.warn("[PNL] Skipping limit check — daily P&L not seeded from broker yet");
    return;
  }
  const reason = breachedLimit();
  if (!reason) return;
  const wasLocked = state.tradingLocked;
  const shortReason = reason.startsWith("Daily profit cap") ? "Daily profit cap reached" : "Daily loss limit reached";
  setTradingLock(true, shortReason);
  console.log(`[PNL] Trading locked - ${reason}`);
  if (announce && !wasLocked) {
    notify(`${reason}. New signals are blocked until midnight UTC or /resume.`);
  }
}

export function updateDailyPnL(closedPnl: number): void {
  state.dailyRealizedPnL += closedPnl;
  console.log(`[PNL] Updated: ${closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(2)} (total: ${state.dailyRealizedPnL.toFixed(2)})`);
  evaluateDailyLimits(true);
}

export function isLocked(): boolean {
  return state.tradingLocked;
}

// At 00:00 UTC, start a fresh trading day: zero the realized P&L and clear the
// daily-loss trading lock. Fires once per day.
export function startDailyReset(): void {
  let resetToday = false;
  let lastDay = new Date().getUTCDate();

  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDate();
    if (day !== lastDay) {
      lastDay = day;
      resetToday = false;
    }

    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0 && !resetToday) {
      resetToday = true;
      state.dailyRealizedPnL = 0;
      state.dailyPnLSeeded = true; // we just set it to 0 - that is the correct value
      // Yesterday's deals can never be counted again, and the set must not grow
      // without bound across days.
      clearCountedDeals();
      setTradingLock(false);
      console.log("[PNL] New trading day - P&L and lock reset");
    }
  }, 60_000);
}