import { state } from "../state";
import { primaryAccountId } from "../ctrader/accounts";
import { fetchTrader } from "../ctrader/account";

// cTrader limits both ProtoOADealListReq and ProtoOACashFlowHistoryListReq to
// a 7-day window per request.
const WEEK_MS = 604_800_000;
const CACHE_TTL_MS = 60_000;
const DEFAULT_DAYS = 7;

interface BalanceEvent {
  timestamp: number;
  delta: number; // positive increases balance, negative decreases it
}

interface BalancePoint {
  timestamp: number;
  balance: number;
}

export interface BalanceHistoryData {
  points: BalancePoint[];
  accountSize: number;
  currentBalance: number;
}

function isFilledDeal(deal: any): boolean {
  const status = deal.dealStatus;
  return status === 2 || status === 3 || status === "FILLED" || status === "PARTIALLY_FILLED";
}

// Deposit-like operationType values (numeric and string forms).
const DEPOSIT_TYPES = new Set([
  0, "BALANCE_DEPOSIT",
  3, "BALANCE_DEPOSIT_STRATEGY_COMMISSION_INNER",
  5, "BALANCE_DEPOSIT_IB_COMMISSIONS",
  7, "BALANCE_DEPOSIT_IB_SHARED_PERCENTAGE_FROM_SUB_IB",
  8, "BALANCE_DEPOSIT_IB_SHARED_PERCENTAGE_FROM_BROKER",
  9, "BALANCE_DEPOSIT_REBATE",
  11, "BALANCE_DEPOSIT_STRATEGY_COMMISSION_OUTER",
]);

async function fetchDealEventsSince(connection: any, fromMs: number): Promise<BalanceEvent[]> {
  const events: BalanceEvent[] = [];
  const now = Date.now();

  for (let start = fromMs; start < now; start += WEEK_MS) {
    const end = Math.min(start + WEEK_MS, now);
    let from = start;

    // Paginate within the week in case there are more than 1000 deals.
    for (let page = 0; page < 20; page++) {
      console.log(`[BALANCE] ProtoOADealListReq ${new Date(from).toISOString()} -> ${new Date(end).toISOString()} (page ${page})`);
      const res = await connection.sendCommand("ProtoOADealListReq", {
        ctidTraderAccountId: primaryAccountId(),
        fromTimestamp: from,
        toTimestamp: end,
        maxRows: 1000,
      });

      const deals = res.deal || [];
      for (const d of deals) {
        if (!isFilledDeal(d)) continue;
        const ts = Number(d.executionTimestamp || 0);
        if (!ts) continue;
        const md = Number(d.moneyDigits ?? 2);
        const div = Math.pow(10, md);

        if (d.closePositionDetail) {
          const cpd = d.closePositionDetail;
          const cpdMd = Number(cpd.moneyDigits ?? md);
          const cpdDiv = Math.pow(10, cpdMd);
          const net =
            (Number(cpd.grossProfit || 0) + Number(cpd.swap || 0) + Number(cpd.commission || 0)) /
            cpdDiv;
          if (net !== 0) events.push({ timestamp: ts, delta: net });
        } else {
          const commission = Number(d.commission || 0);
          if (commission !== 0) {
            events.push({ timestamp: ts, delta: -commission / div });
          }
        }
      }

      if (!res.hasMore) break;
      const lastTs = deals.reduce((max: number, d: any) => {
        const t = Number(d.executionTimestamp || 0);
        return t > max ? t : max;
      }, from);
      if (lastTs <= from) break;
      from = lastTs;
    }
  }

  return events;
}

async function fetchCashFlowEventsSince(connection: any, fromMs: number): Promise<BalanceEvent[]> {
  const events: BalanceEvent[] = [];
  const now = Date.now();

  for (let start = fromMs; start < now; start += WEEK_MS) {
    const end = Math.min(start + WEEK_MS, now);
    console.log(`[BALANCE] ProtoOACashFlowHistoryListReq ${new Date(start).toISOString()} -> ${new Date(end).toISOString()}`);
    const res = await connection.sendCommand("ProtoOACashFlowHistoryListReq", {
      ctidTraderAccountId: primaryAccountId(),
      fromTimestamp: start,
      toTimestamp: end,
    });

    const ops = res.depositWithdraw || [];
    for (const op of ops) {
      const ts = Number(op.changeBalanceTimestamp || 0);
      if (!ts) continue;
      const md = Number(op.moneyDigits ?? 2);
      const div = Math.pow(10, md);
      const rawDelta = Number(op.delta || 0);
      if (rawDelta === 0) continue;
      const isDeposit = DEPOSIT_TYPES.has(op.operationType);
      events.push({ timestamp: ts, delta: (isDeposit ? 1 : -1) * (rawDelta / div) });
    }
  }

  return events;
}

async function buildHistory(connection: any, days: number): Promise<BalanceHistoryData> {
  const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;

  let dealEvents: BalanceEvent[] = [];
  let cashEvents: BalanceEvent[] = [];
  let info: { balance: number };

  try {
    [dealEvents, cashEvents, info] = await Promise.all([
      fetchDealEventsSince(connection, fromMs),
      fetchCashFlowEventsSince(connection, fromMs).catch((err: any) => {
        // Some accounts/brokers do not expose cash-flow history. Fall back to
        // trade events only so the chart still renders; transfers will be missing.
        console.warn(
          `[BALANCE] Cash-flow history unavailable: ${err?.errorCode || err?.message || "request failed"}. Reconstructing from trades only.`
        );
        return [] as BalanceEvent[];
      }),
      fetchTrader(connection),
    ]);
  } catch (err: any) {
    console.warn(`[BALANCE] buildHistory failed: ${err?.errorCode || err?.message || "unknown"}`);
    throw err;
  }

  const events = [...dealEvents, ...cashEvents]
    .filter((e) => e.delta !== 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const points: BalancePoint[] = [];
  const now = Date.now();
  let balance = info.balance;

  // Current balance at the right edge of the chart.
  points.push({ timestamp: now, balance });

  // Walk backwards: the balance stored at each event is the balance AFTER the
  // event's impact, then we remove that impact to get the balance before it.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    points.push({ timestamp: e.timestamp, balance });
    balance -= e.delta;
  }

  points.reverse();

  const maxBalance = points.reduce((m, p) => (p.balance > m ? p.balance : m), info.balance);
  const accountSize =
    state.settings.initialBalanceUSD > 0 ? state.settings.initialBalanceUSD : maxBalance;

  return { points, accountSize, currentBalance: info.balance };
}

let cache: { key: string; data: BalanceHistoryData; at: number } | null = null;

export async function getBalanceHistory(
  connection: any,
  days = DEFAULT_DAYS
): Promise<BalanceHistoryData> {
  const key = `${days}:${Math.floor(Date.now() / CACHE_TTL_MS)}`;
  if (cache && cache.key === key) {
    return cache.data;
  }
  const data = await buildHistory(connection, days);
  cache = { key, data, at: Date.now() };
  return data;
}
