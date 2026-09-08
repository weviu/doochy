import { primaryRuntimes } from "../../state";
import { getMarkPrice, quoteToUsd } from "../../ctrader/livePrices";
import { accountLabel } from "../../ctrader/brokerDirectory";

export interface PositionRow {
  accountId: string;
  // Account display tag (broker + login) from the REST directory, when loaded:
  // "5043626 Leveraged". null until then, so clients fall back to the bare
  // accountId.
  accountTag: string | null;
  posId: number;
  direction: "BUY" | "SELL";
  symbol: string;
  volume: number;
  entryPrice: number;
  mark: number;
  sl: number | null;
  tp: number | null;
  pnl: number;
  timeExitMinLeft: number | null; // minutes left on a time exit, or null if none
  source: string | null; // "Manual" for a hand-placed order; null once rebuilt from the broker
  // Costs booked so far, in USD (negative). pnl above stays GROSS — it matches
  // the broker's own grossProfit exactly — so these are shown separately rather
  // than folded in. Commission is per side: an open position carries only the
  // entry side, and the exit is charged when it closes.
  commission: number;
  swap: number;
  openTime: number; // epoch ms of the fill, for "held for" in the mini-app
}

// Compute the live open-position rows both /positions (text) and the Mini App
// API (JSON) render. P&L is quote-converted to USD via the spot streams.
export function getAllPositionsData(): { positions: PositionRow[]; totalPnL: number } {
  const positions: PositionRow[] = [];
  let totalPnL = 0;

  for (const rt of primaryRuntimes()) {
    for (const [posId, pos] of rt.positions.entries()) {
      // Account-aware mark/conversion: quotes live in the account's own symbol
      // space (each account on its own environment; symbol names differ across
      // accounts/brokers), so without rt.ctid a manual position's symbol (e.g.
      // SP500 on the live environment) resolves no quote here and its P&L
      // silently reads 0.00.
      const mark = getMarkPrice(pos.symbol, pos.direction, rt.ctid) ?? pos.entryPrice;
      const priceDiff = pos.direction === "BUY" ? mark - pos.entryPrice : pos.entryPrice - mark;
      const units = pos.volumeCents / 100;
      const pnl = priceDiff * units * (quoteToUsd(pos.symbol, rt.ctid) ?? 1);
      totalPnL += pnl;

      let timeExitMinLeft: number | null = null;
      if (pos.timeExitMin && pos.timeExitMin > 0) {
        timeExitMinLeft = Math.round((pos.openTime + pos.timeExitMin * 60_000 - Date.now()) / 60_000);
      }

      positions.push({
        accountId: String(rt.ctid),
        accountTag: accountLabel(rt.ctid),
        posId,
        direction: pos.direction,
        symbol: pos.symbol,
        volume: pos.volume,
        entryPrice: pos.entryPrice,
        mark,
        sl: pos.sl ?? null,
        tp: pos.tp ?? null,
        pnl,
        timeExitMinLeft,
        source: pos.source ?? null,
        commission: pos.commission ?? 0,
        swap: pos.swap ?? 0,
        openTime: pos.openTime,
      });
    }
  }

  return { positions, totalPnL };
}

export async function positionsCmd(ctx: any) {
  const { positions, totalPnL } = getAllPositionsData();

  if (positions.length === 0) {
    await ctx.reply("No open positions.");
    return;
  }

  const fmt = (v: number | null) => (v != null ? String(v) : "—");
  const multi = new Set(positions.map((p) => p.accountId)).size > 1;
  const acct = (p: PositionRow) => (multi ? `[${p.accountTag ?? p.accountId}] ` : "");
  const lines = positions.map((p) => {
    const pnlStr = `${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}`;
    let timeLine = "";
    if (p.timeExitMinLeft != null) {
      timeLine = p.timeExitMinLeft > 0
        ? `\n  Time exit: ${p.timeExitMinLeft}m left`
        : `\n  Time exit: due now (closing)`;
    }
    // Only manual positions carry a tag: signal trades are the norm, so leaving
    // them unlabelled keeps the common listing unchanged.
    const tag = p.source === "Manual" ? " (manual)" : "";
    // Only show costs when there are any, so the common line stays clean.
    const costs = p.commission + p.swap;
    const costLine = costs !== 0 ? `\n  Costs: ${costs.toFixed(2)}` : "";
    return (
      `${acct(p)}${p.direction} ${p.symbol} ${p.volume}L${tag}\n` +
      `  Entry: ${p.entryPrice}  Mark: ${p.mark}\n` +
      `  SL: ${fmt(p.sl)}  TP: ${fmt(p.tp)}\n` +
      `  P&L: ${pnlStr}` + costLine + timeLine
    );
  });

  const summary = `Open positions (${positions.length}):\n\n` +
    lines.join("\n\n") +
    (positions.length > 1 ? `\n\nTotal P&L: ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}` : "");

  await ctx.reply(summary);
}
