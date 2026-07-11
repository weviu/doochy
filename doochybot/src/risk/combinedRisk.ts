import { state } from "../state";
import { quoteToUsd } from "../ctrader/livePrices";

// Combined risk across all open positions in the same "trade idea" (same symbol
// AND same direction), for InstantFunding's per-trade-idea risk limit. The summed
// potential loss of a trade idea must not exceed maxCombinedRiskUSD. The opposite
// direction is a separate trade idea and is summed independently.
//
// A position's potential loss uses the bot's money model, the same one floatingPnL
// uses: |entry - sl| * volumeCents / 100, converted from quote currency to USD via
// quoteToUsd (1 for USD-quoted). A position with no SL set yet (the post-fill amend
// is still pending), or one whose USD conversion rate isn't available, falls back to
// the per-trade risk target as a conservative USD estimate.

export interface PositionRisk {
  potentialLoss: number;
  hasSL: boolean;
}

export interface CombinedRisk {
  existingSum: number;
  positions: PositionRisk[];
}

function positionPotentialLoss(
  symbol: string,
  entryPrice: number,
  sl: number | null | undefined,
  volumeCents: number,
  fallbackRisk: number
): PositionRisk {
  if (sl === null || sl === undefined || !entryPrice) {
    return { potentialLoss: fallbackRisk, hasSL: false };
  }
  // Convert the quote-currency risk to USD. If no rate is available, treat the SL as
  // unknown and use the conservative per-trade fallback rather than an unconverted
  // (wrong-currency) figure.
  const factor = quoteToUsd(symbol);
  if (factor === null) {
    return { potentialLoss: fallbackRisk, hasSL: false };
  }
  return { potentialLoss: Math.abs(entryPrice - sl) * (volumeCents / 100) * factor, hasSL: true };
}

// Summed potential loss of all open positions in the same symbol+direction.
// fallbackRisk (the per-trade risk target) covers positions with no SL yet.
export function existingCombinedRisk(
  symbol: string,
  direction: "BUY" | "SELL",
  fallbackRisk: number
): CombinedRisk {
  const positions: PositionRisk[] = [];
  let existingSum = 0;
  for (const pos of state.positions.values()) {
    if (pos.symbol !== symbol || pos.direction !== direction) continue;
    const r = positionPotentialLoss(pos.symbol, pos.entryPrice, pos.sl, pos.volumeCents, fallbackRisk);
    positions.push(r);
    existingSum += r.potentialLoss;
  }
  return { existingSum, positions };
}
