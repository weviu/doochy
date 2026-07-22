import { state } from "../../state";
import { fetchTrader, fetchTodayRealizedPnL } from "../../ctrader/account";
import { activeCooldowns } from "../../risk/cooldown";
import { floatingPnL, maxLossUSD } from "../../risk/dailyLoss";
import { getReentryCooldown } from "../../risk/reentryCooldown";

let connection: any = null;

export function setStatusConnection(conn: any): void {
  connection = conn;
}

export interface StatusData {
  connected: boolean;
  accountId: string;
  balance: number;
  currency: string;
  paused: boolean;
  locked: boolean;
  lockReason: string | null; // why the daily lock is on, when locked
  openPositions: number;
  maxPositions: number;
  dailyRealizedPnL: number;
  floatingPnL: number;
  profitCapUSD: number;      // 0 = off
  capUsed: number;           // realized + floating, for cap progress
  maxLossUSD: number;
  riskPerTradeUSD: number;
  minConfidence: number;
  btcBiasGate: boolean;
  marginAware: boolean;
  allowedSymbols: string[];
  cooldowns: { symbol: string; remainingMs: number }[];
  // Per symbol+direction re-entry blocks after a losing close (prop-firm
  // same-trade-idea rule); distinct from the consecutive-loss cooldowns above.
  reentryCooldowns: { symbol: string; direction: "BUY" | "SELL"; remainingMs: number }[];
}

// Assemble the live status snapshot both /status (text) and the Mini App API
// (JSON) render. Uses the passed connection for the authoritative balance and
// today's realized P&L, falling back to cached/in-memory values if a broker
// read fails, so it never throws.
export async function getStatusData(conn: any): Promise<StatusData> {
  let connOk = false;
  let info = state.accountInfo;
  if (conn) {
    try {
      info = await fetchTrader(conn);
      connOk = true;
    } catch {
      connOk = false;
    }
  }

  let dailyPnL = state.dailyRealizedPnL;
  if (connOk) {
    try {
      dailyPnL = await fetchTodayRealizedPnL(conn);
    } catch {
      dailyPnL = state.dailyRealizedPnL;
    }
  }

  const liveFloating = floatingPnL();
  const cooldowns = activeCooldowns().map((c) => ({ symbol: c.symbol, remainingMs: c.remainingMs }));

  // Active re-entry blocks: one per symbol+direction whose cooldown is still
  // running (getReentryCooldown also lazily drops expired entries).
  const reentryCooldowns: { symbol: string; direction: "BUY" | "SELL"; remainingMs: number }[] = [];
  for (const key of state.lossReentry.keys()) {
    const [symbol, dir] = key.split(":");
    const direction: "BUY" | "SELL" = dir === "SELL" ? "SELL" : "BUY";
    const remainingMs = getReentryCooldown(symbol, direction);
    if (remainingMs != null) reentryCooldowns.push({ symbol, direction, remainingMs });
  }

  return {
    connected: connOk,
    accountId: process.env.ACCOUNT_ID || "?",
    balance: info.balance,
    currency: info.currency,
    paused: state.paused,
    locked: state.tradingLocked,
    lockReason: state.lockReason,
    openPositions: state.positions.size,
    maxPositions: state.settings.maxPositions,
    dailyRealizedPnL: dailyPnL,
    floatingPnL: liveFloating,
    profitCapUSD: state.settings.dailyProfitCapUSD,
    capUsed: dailyPnL + liveFloating,
    maxLossUSD: maxLossUSD(),
    riskPerTradeUSD: state.settings.riskPerTradeUSD,
    minConfidence: state.settings.minConfidence,
    btcBiasGate: state.settings.btcBiasGate,
    marginAware: state.settings.marginAware,
    allowedSymbols: state.settings.allowedSymbols,
    cooldowns,
    reentryCooldowns,
  };
}

export async function statusCmd(ctx: any) {
  const s = await getStatusData(connection);

  const lines = [
    `cTrader: ${s.connected ? "connected" : "not connected"}`,
    `Account: ${s.accountId}`,
    `Balance: ${s.balance.toFixed(2)} ${s.currency}`,
    `Trading: ${s.paused ? "paused" : "active"}${s.locked ? ` (locked${s.lockReason ? `: ${s.lockReason}` : ""})` : ""}`,
    `Open positions: ${s.openPositions}/${s.maxPositions}`,
    `Daily realized P&L: ${s.dailyRealizedPnL >= 0 ? "+" : ""}${s.dailyRealizedPnL.toFixed(2)} ${s.currency}`,
    `Floating P&L: ${s.floatingPnL >= 0 ? "+" : ""}${s.floatingPnL.toFixed(2)} ${s.currency}`,
    `Profit cap: ${s.profitCapUSD > 0 ? `$${s.profitCapUSD.toFixed(2)} (total ${s.capUsed.toFixed(2)} used)` : "off"}`,
    `Daily loss limit: -$${s.maxLossUSD.toFixed(2)} (force-close all)`,
    `Min confidence: ${s.minConfidence > 0 ? `${s.minConfidence} (feed signals; channel bypasses)` : "off"}`,
    `BTC-bias gate: ${s.btcBiasGate ? `on (crypto BUY needs >=${state.settings.btcBiasMinConfBearish} BEARISH / >=${state.settings.btcBiasMinConfStrongBearish} BEARISH_STRONG)` : "off"}`,
    `Margin-aware sizing: ${s.marginAware ? "on" : "off"}`,
    `Sizing: ${s.riskPerTradeUSD > 0 ? `$${s.riskPerTradeUSD.toFixed(2)} risk/trade, sized to the signal's own SL (TP from signal)` : "not set - /risk pertrade required to trade"}`,
    `Cooldowns: ${s.cooldowns.length === 0 ? "none" : s.cooldowns.map((c) => `${c.symbol} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`,
    `Re-entry blocked: ${s.reentryCooldowns.length === 0 ? "none" : s.reentryCooldowns.map((c) => `${c.symbol} ${c.direction} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`,
    `Allowed symbols: ${s.allowedSymbols.length}`,
  ];
  await ctx.reply(lines.join("\n"));
}
