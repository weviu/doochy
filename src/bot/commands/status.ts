import { state, primaryRuntimes } from "../../state";
import { fetchTrader } from "../../ctrader/account";
import { activeCooldowns } from "../../risk/cooldown";
import { floatingPnL, floatingPnLUsd, maxLossUSD } from "../../risk/engine";
import { getReentryCooldown } from "../../risk/reentryCooldown";
import { storeConnection, envForAccount, connectionFor, EnvName } from "../../ctrader/environments";

export function setStatusConnection(env: EnvName, conn: any): void {
  storeConnection(env, conn);
}

export interface AccountStatusLite {
  accountId: string;
  env: string;
  balance: number;
  currency: string;
  paused: boolean;
  locked: boolean;
  lockReason: string | null;
  openPositions: number;
  dailyRealizedPnL: number;
  floatingPnL: number;
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
  initialBalanceUSD: number;
  // Per-account breakdown when more than one account is traded; empty when the
  // snapshot covers a single account (the aggregate fields ARE that account).
  accounts: AccountStatusLite[];
}

// Assemble the live status snapshot both /status (text) and the Mini App API
// (JSON) render. With multiple traded accounts the figures are the SUM across
// all of them (limits still enforced per account), and the per-account lines
// are included for the /status text. Each account's balance is read over its
// OWN environment's connection, falling back to cached in-memory values if a
// broker read fails, so it never throws.
export async function getStatusData(): Promise<StatusData> {
  const rts = primaryRuntimes();

  let connected = false;
  let balance = 0;
  let currency = "USD";
  let openPositions = 0;
  let dailyPnL = 0;
  let acc = 0;
  const accountLines: AccountStatusLite[] = [];

  for (const rt of rts) {
    let info = rt.accountInfo; // in-memory cache (seeded at boot / on fetch)
    let infoOk = info !== undefined;
    const env = envForAccount(rt.ctid);
    const conn = env !== undefined ? connectionFor(env) : undefined;
    if (conn) {
      try {
        info = await fetchTrader(conn, rt.ctid); // refreshes rt.accountInfo + cache
        infoOk = true;
      } catch {
        // keep whatever we had
      }
    }
    if (infoOk) connected = true;
    if (info) {
      balance += info.balance;
      acc++;
      if (acc === 1) currency = info.currency;
    }

    const float = floatingPnL(rt);
    const locked = rt.tradingLocked;
    openPositions += rt.positions.size;
    dailyPnL += rt.dailyRealizedPnL;
    accountLines.push({
      accountId: String(rt.ctid),
      env: env ?? "",
      balance: info?.balance ?? 0,
      currency: info?.currency ?? currency,
      paused: state.paused,
      locked,
      lockReason: rt.lockReason,
      openPositions: rt.positions.size,
      dailyRealizedPnL: rt.dailyRealizedPnL,
      floatingPnL: float.usd,
    });
  }

  // The engine's counter IS the authoritative figure (broker-seeded at boot and
  // on every reconnect, then updated per closing deal). The old refetch here
  // could show a different number than enforcement was using — and against the
  // wrong (UTC) day window at that.
  const liveFloating = floatingPnLUsd();
  const cooldowns = rts.flatMap((rt) =>
    activeCooldowns(rt).map((c) => ({ symbol: c.symbol, remainingMs: c.remainingMs }))
  );

  // Active re-entry blocks: one per symbol+direction per account whose cooldown
  // is still running (getReentryCooldown also lazily drops expired entries).
  const reentryCooldowns: { symbol: string; direction: "BUY" | "SELL"; remainingMs: number }[] = [];
  for (const rt of rts) {
    for (const key of rt.lossReentry.keys()) {
      const [symbol, dir] = key.split(":");
      const direction: "BUY" | "SELL" = dir === "SELL" ? "SELL" : "BUY";
      const remainingMs = getReentryCooldown(rt, symbol, direction);
      if (remainingMs != null) reentryCooldowns.push({ symbol, direction, remainingMs });
    }
  }

  const lockedAccount = accountLines.find((a) => a.locked);
  const accountId = rts.length === 1 ? String(rts[0].ctid) : `${rts.length} accounts`;

  return {
    connected,
    accountId,
    balance,
    currency,
    paused: state.paused,
    locked: rts.some((rt) => rt.tradingLocked),
    lockReason: lockedAccount?.lockReason ?? null,
    openPositions,
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
    initialBalanceUSD: state.settings.initialBalanceUSD,
    accounts: accountLines,
  };
}

// Mirrors the mini-app's Dashboard: live runtime state only, same figures in the
// same order. Configuration lines (min confidence, margin-aware, midnight
// flatten) are not repeated here — the Dashboard doesn't show them and /settings
// already does.
export async function statusCmd(ctx: any) {
  const s = await getStatusData();
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
  const net = s.dailyRealizedPnL + s.floatingPnL;
  // With several accounts, a summed balance misleads — show each account's own.
  const balanceLine =
    s.accounts.length > 1
      ? `Balance: ${s.accounts.map((a) => `${a.accountId}: ${a.balance.toFixed(2)} ${a.currency || s.currency}`).join(" · ")}`
      : `Balance: ${s.balance.toFixed(2)} ${s.currency}`;

  const lines = [
    balanceLine,
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

  // Per-account breakdown on multi-account setups.
  if (s.accounts.length > 1) {
    lines.push("", s.accounts.map((a) => {
      const state = a.locked ? `locked${a.lockReason ? ` (${a.lockReason})` : ""}` : a.paused ? "paused" : "active";
      return `[${a.env || "?"}] ${a.accountId}: ${a.balance.toFixed(2)} ${a.currency} · ${state} · ${a.openPositions} pos · day ${sign(a.dailyRealizedPnL)} ${a.currency}`;
    }).join("\n"));
  }

  // Only shown when active, matching the Dashboard's conditional cards.
  if (s.cooldowns.length > 0) {
    lines.push("", `Cooldowns: ${s.cooldowns.map((c) => `${c.symbol} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`);
  }
  if (s.reentryCooldowns.length > 0) {
    lines.push(`Re-entry blocked: ${s.reentryCooldowns.map((c) => `${c.symbol} ${c.direction} ${Math.ceil(c.remainingMs / 60_000)}m`).join(", ")}`);
  }

  await ctx.reply(lines.join("\n"));
}