import { state } from "../../state";
import { getMarkPrice, quoteToUsd } from "../../ctrader/livePrices";

export async function positionsCmd(ctx: any) {
  if (state.positions.size === 0) {
    await ctx.reply("No open positions.");
    return;
  }

  const lines: string[] = [];
  let totalPnL = 0;

  for (const [posId, pos] of state.positions.entries()) {
    const sl = pos.sl;
    const tp = pos.tp;

    const mark = getMarkPrice(pos.symbol, pos.direction) ?? pos.entryPrice;
    const priceDiff = pos.direction === "BUY" ? mark - pos.entryPrice : pos.entryPrice - mark;
    const units = pos.volumeCents / 100;
    // Convert quote-currency P&L to USD (1 for USD-quoted; conversion-pair rate for
    // JPY/CAD-quoted). Fall back to 1 if a rate isn't available so the row still shows.
    const pnl = priceDiff * units * (quoteToUsd(pos.symbol) ?? 1);
    totalPnL += pnl;
    const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;

    const fmt = (v: number | null | undefined) =>
      v != null ? String(v) : "—";

    // Time-exit countdown, only for positions that carry a timer.
    let timeLine = "";
    if (pos.timeExitMin && pos.timeExitMin > 0) {
      const remainMin = Math.round((pos.openTime + pos.timeExitMin * 60_000 - Date.now()) / 60_000);
      timeLine = remainMin > 0
        ? `\n  Time exit: ${remainMin}m left (of ${pos.timeExitMin}m)`
        : `\n  Time exit: due now (closing)`;
    }

    lines.push(
      `${pos.direction} ${pos.symbol} ${pos.volume}L\n` +
      `  Entry: ${pos.entryPrice}  Mark: ${mark}\n` +
      `  SL: ${fmt(sl)}  TP: ${fmt(tp)}\n` +
      `  P&L: ${pnlStr}` + timeLine
    );
  }

  const summary = `Open positions (${state.positions.size}):\n\n` +
    lines.join("\n\n") +
    (state.positions.size > 1 ? `\n\nTotal P&L: ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}` : "");

  await ctx.reply(summary);
}
