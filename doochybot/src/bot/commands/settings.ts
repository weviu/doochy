import { state } from "../../state";
import { ENTRY_TOLERANCE_PERCENT } from "../../ctrader/orders";

// Show the user's configured settings (the knobs set via /risk, /minhold, etc.),
// grouped to match the /help categories. Distinct from /status, which shows live
// runtime state (connection, P&L, open positions).
export async function settingsCmd(ctx: any) {
  const s = state.settings;
  const off = "off";

  const lines = [
    "SETTINGS",
    "",
    `Symbols: ${s.allowedSymbols.length ? s.allowedSymbols.join(", ") : "none"}`,
    `Max positions: ${s.maxPositions}`,
    "",
    "Sizing",
    `Per-trade risk: ${s.riskPerTradeUSD > 0 ? `$${s.riskPerTradeUSD}` : "not set (trading off)"}`,
    `Risk overrun tolerance: ${s.riskOverrunPercent > 0 ? `+${s.riskOverrunPercent}% over target (min-lot skipped beyond)` : "strict (0% - skip any over target)"}`,
    "SL/TP: from the signal (sized to its stop; no SL/TP = skipped)",
    `Entry tolerance (feed market vs resting order): ${ENTRY_TOLERANCE_PERCENT}% (fixed)`,
    `Stale-order guard (feed resting orders): ${s.staleOrderBars > 0 ? `${s.staleOrderBars} bars of the signal timeframe` : "off (good-till-cancel)"}`,
    `Min hold before TP: ${s.minHoldSeconds}s`,
    "",
    "Daily limits",
    `Max daily loss: $${s.maxDailyLossUSD}`,
    `Profit cap: ${s.dailyProfitCapUSD > 0 ? `$${s.dailyProfitCapUSD} (buffer $${s.capBufferUSD})` : off}`,
    `Combined risk (same symbol+direction): ${s.maxCombinedRiskUSD > 0 ? `$${s.maxCombinedRiskUSD}` : off}`,
    "",
    "Cooldowns",
    `Consecutive-loss: ${s.maxConsecutiveLosses > 0 ? `${s.maxConsecutiveLosses} SL hits / ${s.lossWindowMinutes}m window -> ${s.cooldownMinutes}m pause` : off}`,
    `Re-entry after a loss: ${s.reentryCooldownMinutes > 0 ? `${s.reentryCooldownMinutes}m` : off}`,
    "",
    `Channel signal confidence: ${s.webhookConfidence}`,
    `Min confidence to open (feed): ${s.minConfidence > 0 ? s.minConfidence : off}`,
    `BTC-bias gate (crypto BUYs): ${s.btcBiasGate ? `on (>=${s.btcBiasMinConfBearish} BEARISH / >=${s.btcBiasMinConfStrongBearish} BEARISH_STRONG)` : off}`,
    `Margin-aware sizing: ${s.marginAware ? "on" : off}`,
    `Order notifications: ${s.notifyFills ? "on" : "off"}`,
  ];

  await ctx.reply(lines.join("\n"));
}
