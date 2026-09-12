import { persistRuntime, RuntimeState } from "../state";

// Re-entry cooldown after a loss (InstantFunding prop-firm "same trade idea"
// rule). When a position closes at a loss, reopening the SAME symbol AND
// direction within a window counts as the same trade idea, and the combined loss
// counts toward the per-trade risk limit. To stay compliant we block re-entry on
// that symbol+direction for reentryCooldownMinutes after the losing close.
//
// Distinct from the consecutive-loss cooldown in cooldown.ts: that one pauses a
// symbol (either direction) after several SL hits; this one fires on a SINGLE
// loss and is direction-specific. Wins never trigger it, and the opposite
// direction is a separate trade idea so it is never blocked here.
//
// Stored per account in rt.lossReentry and persisted to data/runtime.json, so
// it survives a restart (the prop-firm compliance windows are part of the
// persisted runtime, like the symbol cooldowns).

const MIN_MS = 60_000;

function key(symbol: string, direction: "BUY" | "SELL"): string {
  return `${symbol}:${direction}`;
}

// Record a losing close on ONE account. Stores the close time, keyed by
// symbol+direction, on that account's runtime.
export function recordLoss(rt: RuntimeState, symbol: string, direction: "BUY" | "SELL", time = Date.now()): void {
  rt.lossReentry.set(key(symbol, direction), time);
  persistRuntime();
  const mins = rt.settings.reentryCooldownMinutes;
  if (mins > 0) {
    console.log(`[REENTRY] ${direction} ${symbol} closed at a loss - re-entry blocked for ${mins}m`);
  }
}

// Remaining cooldown in ms for a symbol+direction on ONE account, or null if
// none / expired / disabled. Expired entries are cleared lazily on access.
export function getReentryCooldown(
  rt: RuntimeState,
  symbol: string,
  direction: "BUY" | "SELL",
  now = Date.now()
): number | null {
  const mins = rt.settings.reentryCooldownMinutes;
  if (mins <= 0) return null; // disabled

  const k = key(symbol, direction);
  const closedAt = rt.lossReentry.get(k);
  if (closedAt === undefined) return null;

  const remaining = closedAt + mins * MIN_MS - now;
  if (remaining <= 0) {
    rt.lossReentry.delete(k);
    return null;
  }
  return remaining;
}

// Format a remaining duration as "7m 23s".
export function formatRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
