import { initData } from "./telegram";

// Shapes mirror the backend (src/bot/commands/status.ts, positions.ts).
export interface StatusData {
  connected: boolean;
  accountId: string;
  balance: number;
  currency: string;
  paused: boolean;
  locked: boolean;
  lockReason: string | null;
  openPositions: number;
  maxPositions: number;
  dailyRealizedPnL: number;
  floatingPnL: number;
  profitCapUSD: number;
  capUsed: number;
  maxLossUSD: number;
  riskPerTradeUSD: number;
  minConfidence: number;
  marginAware: boolean;
  allowedSymbols: string[];
  cooldowns: { symbol: string; remainingMs: number }[];
  reentryCooldowns: { symbol: string; direction: "BUY" | "SELL"; remainingMs: number }[];
  initialBalanceUSD: number;
}

export interface Account {
  accountId: string; // cTrader account id (ctid)
  accountTag: string; // display tag for the picker, e.g. "5043626 Leveraged"
}

export interface AccountsData {
  accounts: Account[];
}

export interface PositionRow {
  accountId: string;
  accountTag: string;
  posId: number;
  direction: "BUY" | "SELL";
  symbol: string;
  volume: number;
  entryPrice: number;
  mark: number;
  sl: number | null;
  tp: number | null;
  pnl: number;
  timeExitMinLeft: number | null;
  source: string | null; // "Manual" for a hand-placed order
  // Booked costs in USD (negative). pnl is GROSS, matching the broker's own
  // figure; these are shown separately rather than folded into it.
  commission: number;
  swap: number;
  openTime: number;
}

export interface PositionsData {
  positions: PositionRow[];
  totalPnL: number;
}

// A resting (unfilled) LIMIT/STOP entry order sitting at the broker. Placed from
// the Trade tab (or in cTrader directly), it isn't a position until price reaches
// its level, so it needs its own list separate from open positions.
export interface PendingOrderRow {
  accountId: string;
  orderId: number;
  direction: "BUY" | "SELL";
  symbol: string;
  orderType: "LIMIT" | "STOP";
  price: number; // resting level (limit price, or stop trigger)
  volume: number; // lots
  sl: number | null;
  tp: number | null;
  placedAt: number;
  expiresAt: number | null; // epoch ms if it auto-expires, else null
}

export interface PendingOrdersData {
  orders: PendingOrderRow[];
}

// One signal the gate evaluated (executed or rejected), for the Signals view.
export interface SignalRecord {
  receivedAt: number;
  symbol: string;
  direction: "BUY" | "SELL";
  confidence: number;
  price: number;
  sl: number | null;
  tp: number | null;
  timeframe: string;
  source: string | null;
  signalSource: string | null;
  btcState: string | null;
  outcome: "executed" | "rejected";
  reason: string | null;
}

export interface SignalsData {
  signals: SignalRecord[];
}

// The full agent-side settings object (src/state.ts BotSettings). Every field is
// editable from the panel by relaying the matching Telegram command.
export interface Settings {
  allowedSymbols: string[];
  maxPositions: number;
  maxDailyLossUSD: number;
  minHoldSeconds: number;
  riskPerTradeUSD: number;
  riskOverrunPercent: number;
  dailyProfitCapUSD: number;
  capBufferUSD: number;
  maxConsecutiveLosses: number;
  lossWindowMinutes: number;
  cooldownMinutes: number;
  reentryCooldownMinutes: number;
  maxCombinedRiskUSD: number;
  notifyFills: boolean;
  signalNotify: boolean;
  signalNotifyMinConfidence: number;
  webhookConfidence: number;
  minConfidence: number;
  marginAware: boolean;
  midnightFlatten: boolean;
  initialBalanceUSD: number;
}

// Balance chart data: reconstructed from cTrader deal + cash-flow history.
export interface BalancePoint {
  timestamp: number;
  balance: number;
}

export interface BalanceHistoryData {
  points: BalancePoint[];
  accountSize: number;
  currentBalance: number;
}

// A command relay always returns the display text plus a fresh settings
// snapshot, so the panel can refresh its forms from the authoritative agent
// state after every change.
// A file a command produced (today only /export), carried inline as base64.
export interface CommandDocument {
  filename: string;
  data: string; // base64
  caption?: string;
}

export interface CommandResult {
  text: string;
  settings: Settings | null;
  document?: CommandDocument | null;
}

// Live price + tradable size grid for one allowed symbol (manual-order panel).
export interface Quote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  hasQuote: boolean;
  tradable: boolean;
  minLots: number | null;
  lotStep: number | null;
}

export interface QuotesData {
  quotes: Quote[];
}

// What a size (or a risk) actually means, computed agent-side by the same code
// that sizes the real order. riskUSD/lots are the FINAL values after the
// broker's grid snapping, not what was requested.
export interface OrderPreview {
  symbol: string;
  markPrice: number | null;
  entryRef: number | null;
  lots: number | null;
  volumeCents: number | null;
  riskUSD: number | null;
  rewardUSD: number | null;
  rr: number | null;
  snapped: boolean;
  minLots: number | null;
  lotStep: number | null;
  warnings: string[];
}

export interface OrderPreviewParams {
  symbol: string;
  direction: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  entry?: number | null;
  sl?: number | null;
  tp?: number | null;
  mode: "size" | "risk";
  lots?: number | null;
  riskUSD?: number | null;
}

async function request<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      // Signed Telegram payload; the server validates it against the bot token.
      Authorization: `tma ${initData()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// Query-string segment for the account scope. The mini-app requests only its
// own small set of endpoints with an account; omit it when no account is
// selected yet (falling back to the agent's default account).
function q(ctid: string | undefined): string {
  return ctid ? `?ctid=${encodeURIComponent(ctid)}` : "";
}

export const api = {
  // The traded accounts + display tags, for the account picker.
  accounts: () => request<AccountsData>("/accounts"),
  // An optional ctid scopes every read below to that one account (the whole
  // mini-app shows one account at a time via the picker). No ctid = the agent's
  // default account (its /status and /positions show all accounts).
  status: (ctid?: string) => request<StatusData>(`/status${q(ctid)}`),
  positions: (ctid?: string) => request<PositionsData>(`/positions${q(ctid)}`),
  signals: () => request<SignalsData>("/signals"),
  settings: () => request<Settings>("/settings"),
  pause: () => request<{ paused: boolean }>("/pause", "POST"),
  resume: () => request<{ paused: boolean; lockCleared: boolean }>("/resume", "POST"),
  closeall: () => request<{ closed: number; failed: number; total: number }>("/closeall", "POST"),
  // Run a Telegram command (e.g. command("risk", ["pertrade", "50"])) through
  // the agent and get back its reply text and refreshed settings.
  command: (cmd: string, args: string[] = []) =>
    request<CommandResult>("/command", "POST", { cmd, args }),
  // Trade history export. Dates are YYYY-MM-DD (the command's own format);
  // omit both for the default last-7-days. Returns the JSON file inline.
  exportTrades: (from?: string, to?: string) =>
    request<CommandResult>("/command", "POST", {
      cmd: "export",
      args: [from, to].filter(Boolean),
    }),
  // Live price + size grid for the selected account's broker.
  quotes: (ctid?: string) => request<QuotesData>(`/quotes${q(ctid)}`),
  availableSymbols: () => request<{ symbols: string[] }>("/symbols/available"),
  // Preview sizes the order against the SELECTED account's mark price and broker
  // grid, so the ctid is part of the request body.
  orderPreview: (p: OrderPreviewParams, ctid?: string) =>
    request<OrderPreview>("/order/preview", "POST", { ...p, ctid }),
  closePosition: (posId: number, ctid?: string) =>
    request<{ closed: boolean; text: string }>("/position/close", "POST", { posId, ctid }),
  pendingOrders: (ctid?: string) =>
    request<PendingOrdersData>(`/orders/pending${q(ctid)}`),
  cancelOrder: (orderId: number, ctid?: string) =>
    request<{ cancelled: boolean; text: string }>("/order/cancel", "POST", { orderId, ctid }),
  // Edit a resting order. Pass only the fields to change (null keeps current):
  // price = new limit/trigger level, sl/tp = new stop/target.
  amendOrder: (orderId: number, changes: { price?: number | null; sl?: number | null; tp?: number | null }, ctid?: string) =>
    request<{ text: string }>("/order/amend", "POST", { orderId, ...changes, ctid }),
  amendPosition: (posId: number, sl: number | null, tp: number | null, ctid?: string) =>
    request<{ text: string }>("/position/amend", "POST", { posId, sl, tp, ctid }),
  balanceHistory: (days = 7, ctid?: string) =>
    request<BalanceHistoryData>(`/balance/history?days=${encodeURIComponent(days)}${ctid ? `&ctid=${encodeURIComponent(ctid)}` : ""}`),
  // Place a manual order on ONE account via the /place_order endpoint, which
  // scopes parsing AND execution to the selected account (== new code path from
  // the chat's all-accounts /order). The agent returns the same display text.
  //   market: BUY XAUUSD 0.02 <TP> <SL>
  //   limit:  BUY XAUUSD 0.02 <entry> <TP> <SL>
  placeOrder: (args: string[], ctid?: string) =>
    request<{ text: string }>("/place_order", "POST", { args, ctid }),
};
