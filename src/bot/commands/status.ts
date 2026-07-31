import { state } from "../../state";
import { fetchTrader } from "../../ctrader/account";
import { activeCooldowns } from "../../risk/cooldown";
import { floatingPnLUsd, maxLossUSD } from "../../risk/engine";
import { getReentryCooldown } from "../../risk/reentryCooldown";
import { primaryAccountId } from "../../ctrader/accounts";

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

  // The engine's counter IS the authoritative figure (broker-seeded at boot and
  // on every reconnect, then updated per closing deal). The old refetch here
  // could show a different number than enforcement was using — and against the
  // wrong (UTC) day window at that.
  const dailyPnL = state.dailyRealizedPnL;
  const liveFloating = floatingPnLUsd();
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
    accountId: String(primaryAccountId() || "?"),
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
    marginAware: state.settings.marginAware,
    allowedSymbols: state.settings.allowedSymbols,
    cooldowns,
    reentryCooldowns,
  };
}

// Mirrors the mini-app's Dashboard: live runtime state only, same figures in the
// same order. Configuration lines (min confidence, margin-aware, midnight
// flatten) are not repeated here — the Dashboard doesn't show them and /settings
// already does.
export async function statusCmd(ctx: any) {
  const s = await getStatusData(connection);
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
  const net = s.dailyRealizedPnL + s.floatingPnL;

  const lines = [
    `Balance: ${s.balance.toFixed(2)} ${s.currency}`,
    `Account ${s.accountId} · ${s.connected ? "connected" : "disconnected"}`,
    `Trading: ${s.locked ? `locked${s.lockReason ? ` — ${s.lockReason}` : ""}` : s.paused ? "paused" : "active"}`,
    "",
    `Realized today: ${sign(s.dailyRealizedPnL)} ${s.currency}`,
    `Floating: ${sign(s.floatingPnL)} ${s.currency}`,
    `Net today: ${sign(net)} ${s.currency}`,
    "",
    `Profit cap: ${s.profitCapUSD > 0 ? `${s.capUsed.toFixed(2)} / $${s.profitCapUSD.toFixed(2)}` : "off"}`,
    `Daily loss: ${Math.max(0, -net).toFixed(2)} / $${s.maxLossUSD.toFixed(2)}`,
    "",
    `Open positions: ${s.openPositions}/${s.maxPositions}`,
    `Risk per trade: ${s.riskPerTradeUSD > 0 ? `$${s.riskPerTradeUSD.toFixed(2)}` : "not set - /risk pertrade required to trade"}`,
    `Symbols: ${s.allowedSymbols.length}`,
  ];

  // Only shown when active, matching the Dashboard's conditional cards.
  if (s.cooldowns.length > 0) {
    lines.push("", `Cooldowns: ${s.cooldowns.map((c) => `${c.symbol} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`);
  }
  if (s.reentryCooldowns.length > 0) {
    lines.push(`Re-entry blocked: ${s.reentryCooldowns.map((c) => `${c.symbol} ${c.direction} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`);
  }

  await ctx.reply(lines.join("\n"));
}
