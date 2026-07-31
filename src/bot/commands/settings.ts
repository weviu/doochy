import { state } from "../../state";

// Mirrors the mini-app's Settings tab: same fields, same sections, same order.
// The app is the source of truth for what's worth showing, so anything it has no
// control for (risk overrun, channel confidence) is deliberately left out here too.
//
// Distinct from /status, which shows live runtime state (connection, P&L, positions).
export async function settingsCmd(ctx: any) {
  const s = state.settings;
  const off = "off";

  const lines = [
    "SETTINGS",
    "",
    "Risk & sizing",
    `Risk per trade: ${s.riskPerTradeUSD > 0 ? `$${s.riskPerTradeUSD}` : "not set (trading off)"}`,
    `Max positions: ${s.maxPositions}`,
    `Midnight flatten: ${s.midnightFlatten ? "on" : off}`,
    "",
    "Daily limits",
    `Daily loss limit: $${s.maxDailyLossUSD}`,
    `Profit cap: ${s.dailyProfitCapUSD > 0 ? `$${s.dailyProfitCapUSD}` : off}`,
    `Cap buffer: $${s.capBufferUSD}`,
    "",
    `Symbols (${s.allowedSymbols.length}): ${s.allowedSymbols.length ? s.allowedSymbols.join(", ") : "none"}`,
    "",
    "Cooldowns & prop rules",
    `Consecutive losses: ${s.maxConsecutiveLosses > 0 ? `${s.maxConsecutiveLosses}` : off}`,
    `Loss window: ${s.lossWindowMinutes}m`,
    `Cooldown: ${s.cooldownMinutes}m`,
    `Min hold: ${s.minHoldSeconds}s`,
    `Re-entry cooldown: ${s.reentryCooldownMinutes > 0 ? `${s.reentryCooldownMinutes}m` : off}`,
    `Combined risk limit: ${s.maxCombinedRiskUSD > 0 ? `$${s.maxCombinedRiskUSD}` : off}`,
    "",
    "Signal gates",
    `Min confidence: ${s.minConfidence > 0 ? s.minConfidence : off}`,
    `Margin-aware sizing: ${s.marginAware ? "on" : off}`,
    "",
    "Notifications",
    `Order fills: ${s.notifyFills ? "on" : off}`,
    `Signal notifications: ${s.signalNotify ? "on" : off}`,
    ...(s.signalNotify ? [`Signal min confidence: ${s.signalNotifyMinConfidence}`] : []),
  ];

  await ctx.reply(lines.join("\n"));
}
