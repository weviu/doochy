import { loadSettings, saveSettings, loadRuntime, saveRuntime } from "./storage";
import { dayKey } from "./risk/tradingDay";
import { canonicalSymbolKey } from "./ctrader/symbolCanonical";
import { primaryAccounts, primaryAccountId } from "./ctrader/accounts";

export interface Position {
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;       // lots (for display)
  volumeCents: number;  // broker volume unit, needed to close the position
  entryPrice: number;
  openTime: number;
  confidence?: number;  // signal confidence at entry; used for reversal gating
  // Where this position came from ("Manual" for a hand-placed order, otherwise
  // the feed/channel label). Display only: every risk monitor treats a manual
  // position exactly like any other. Rebuilt positions (reconcile after a
  // restart) have no source, since the broker doesn't know who asked.
  source?: string;
  // Trading costs the broker has booked on this position so far, in USD.
  // Display only: the headline P&L stays gross (matching the broker's own
  // grossProfit exactly), and these are shown alongside so the cost is visible
  // rather than silently folded in. commission is charged per side, so an open
  // position carries only the entry side here; the exit is charged on close.
  commission?: number;
  swap?: number;
  sl?: number | null;
  tp?: number | null;
  // Effective time-based exit in minutes from fill (openTime), for in-scope timed
  // signals (gold Connors-RSI). > 0 => the time-exit monitor market-closes this
  // position at openTime + timeExitMin. Absent/null/0 => no time exit (SL/TP only).
  // The authoritative copy is persisted separately (data/time-exits.json) so the
  // timer survives a restart even though positions are rebuilt from the broker.
  timeExitMin?: number | null;
}

// An order that has been submitted to the broker but not yet filled, cancelled,
// or rejected. Tracked so the duplicate gate can reject repeat signals while a
// fill is still outstanding (no Position exists yet at that point).
export interface PendingOrder {
  symbol: string;
  direction: "BUY" | "SELL";
  placedAt: number;
}

export interface BotSettings {
  allowedSymbols: string[];
  maxPositions: number;
  maxDailyLossUSD: number;
  minHoldSeconds: number;
  riskPerTradeUSD: number; // size each position so the signal's own entry-to-SL distance loses ~this many $. Required to trade (0 = trading disabled; there is no fixed-lot fallback).
  riskOverrunPercent: number; // how far a trade's risk may exceed riskPerTradeUSD before it's skipped, as % over target (a wide stop can force the broker's min lot above target). e.g. 20 = allow up to 1.2x. 0 = strict (skip anything over target); set high to effectively disable.
  dailyProfitCapUSD: number; // lock trading once daily realized profit hits this; 0 = disabled
  capBufferUSD: number; // force-close this many $ BELOW the cap to never overshoot it
  maxConsecutiveLosses: number; // SL hits on one symbol within the window that trigger a cooldown; 0 = disabled
  lossWindowMinutes: number; // window over which SL hits are counted
  cooldownMinutes: number; // how long a symbol stays paused after the streak triggers
  reentryCooldownMinutes: number; // after ANY losing close, block re-entry on the same symbol+direction for this long (prop-firm same-trade-idea rule); 0 = disabled
  maxCombinedRiskUSD: number; // max summed potential loss across all open positions of the same symbol+direction (prop-firm per-trade-idea limit); 0 = disabled
  notifyFills: boolean; // send a Telegram message whenever an order fills
  signalNotify: boolean; // send a Telegram message for every incoming signal (executed or not), for trading manually elsewhere
  signalNotifyMinConfidence: number; // only notify on signals scoring at least this; independent of the entry gate
  webhookConfidence: number; // confidence assigned to channel/webhook signals (which carry none); drives reversal gating against feed signals
  minConfidence: number; // reject feed signals scoring below this as an entry gate; channel signals bypass it; 0 = off
  marginAware: boolean; // when true, cap each order's size to fit free margin (ProtoOAExpectedMarginReq); when false, place the full risk-based size
  midnightFlatten: boolean; // when true, flatten all positions and cancel resting orders in the final minutes before the broker's daily reset (prop-firm rollover protection); when false, positions ride through midnight untouched
  initialBalanceUSD: number; // starting/max account balance, used as the fixed "Account size" reference line in the balance chart
}

export interface BotState {
  paused: boolean;
  settings: BotSettings;
  // Per-account runtime state, keyed by ctidTraderAccountId. Every field that
  // used to live top-level here (positions, daily P&L, lock, cooldowns, pending
  // orders, account info) is account-scoped now: one process trades several
  // accounts, each with its own open book and its own daily risk limits. The
  // shared, broker/feed-level fields (settings, symbol map, quote currencies,
  // signal dedupe stamps) stay on the singleton.
  runtimes: Map<number, RuntimeState>;
  lastSignalTime: Map<string, number>;
  symbolMap: Map<string, number>;
  usdQuotedSymbols: Set<string>; // broker symbol names (same keys as symbolMap) whose QUOTE currency is USD. The money model (risk sizing, floating P&L, daily limits) is exact for these; a non-USD-quoted pair is valued via quoteToUsd() instead. Empty until the asset+symbol lists load (then isUsdQuoted fails open).
  symbolQuote: Map<string, string>; // broker symbol name -> its QUOTE currency asset name ("USD","JPY","CAD",...). Populated alongside usdQuotedSymbols; drives quoteToUsd() so a non-USD-quoted symbol's P&L/risk can be converted into USD via the matching conversion pair (USDJPY/USDCAD/etc).
  tradingDisabled: Set<string>; // broker symbols that exist in the full list but are not enabled for trading on this specific account (enabled:false in ProtoOASymbolsListReq). Filtered out by the "add all available" flow so users don't see instruments their account type can't trade.
}

// Everything that is per-account at runtime. The account id (ctid) is the map
// key in BotState.runtimes; this is the value. One instance per trading account
// the process holds a session for; the gate, risk engine, monitors and execution
// path all operate on the runtime of the account they intend to act on.
export interface RuntimeState {
  // The ctidTraderAccountId this runtime belongs to. Set at creation so modules
  // can derive the account from the runtime (order requests, account-info
  // calls) without threading the id around separately.
  ctid: number;
  tradingLocked: boolean;
  lockReason: string | null; // why the daily lock is on (for /status and the app); null when unlocked
  limitOverride: boolean; // user ran /resume after a daily-limit lock: limits stay off until the next broker trading day
  dailyRealizedPnL: number;
  dailyPnLSeeded: boolean; // false until broker seed succeeds; limits are skipped until then
  positions: Map<number, Position>;
  pendingOrders: Map<string, PendingOrder>; // keyed by order label, awaiting fill
  accountInfo: AccountInfo;
  lossReentry: Map<string, number>; // "SYMBOL:DIRECTION" -> epoch ms of the losing close, for the re-entry cooldown
  symbolCooldowns: Map<string, { until: number; triggerHits: number }>; // per-symbol consecutive-loss cooldowns (until = epoch ms)
}

export const DEFAULT_SETTINGS: BotSettings = {
  allowedSymbols: ["BTCUSD", "XAUUSD", "XAGUSD"],
  maxPositions: 3,
  maxDailyLossUSD: 200,
  minHoldSeconds: 60,
  riskPerTradeUSD: 0,
  riskOverrunPercent: 20,
  dailyProfitCapUSD: 0,
  capBufferUSD: 0,
  maxConsecutiveLosses: 3,
  lossWindowMinutes: 60,
  cooldownMinutes: 120,
  reentryCooldownMinutes: 10,
  maxCombinedRiskUSD: 0,
  notifyFills: true,
  signalNotify: false,
  signalNotifyMinConfidence: 50,
  webhookConfidence: 69,
  minConfidence: 50,
  marginAware: true,
  midnightFlatten: true,
  initialBalanceUSD: 0,
};

export const state: BotState = {
  paused: false,
  settings: { ...DEFAULT_SETTINGS },
  runtimes: new Map(),
  lastSignalTime: new Map(),
  symbolMap: new Map(),
  usdQuotedSymbols: new Set(),
  symbolQuote: new Map(),
  tradingDisabled: new Set(),
};

function freshRuntime(ctid: number): RuntimeState {
  return {
    ctid,
    tradingLocked: false,
    lockReason: null,
    limitOverride: false,
    dailyRealizedPnL: 0,
    dailyPnLSeeded: false,
    positions: new Map(),
    pendingOrders: new Map(),
    accountInfo: { balance: 0, equity: 0, currency: "USD" },
    lossReentry: new Map(),
    symbolCooldowns: new Map(),
  };
}

// Runtime state for one account (ctid), created on first use and hydrated from
// the persisted runtime file the first time an account is touched (so a
// restart does not silently clear a prop-rule cooldown or a daily-limit lock).
// All trading modules call this instead of reaching into state.runtimes
// directly, so the map can never be read as empty by a caller that expects the
// account to exist.
export function runtimeFor(ctid: number): RuntimeState {
  let rt = state.runtimes.get(ctid);
  if (!rt) {
    rt = freshRuntime(ctid);
    applyRestored(ctid, rt);
    state.runtimes.set(ctid, rt);
  }
  return rt;
}

// The runtime states for every account the bot trades (all "primary" roles).
// Empty before the account registry resolves during boot; by the time the gate,
// engine, monitors and execution path run, it holds one entry per primary.
export function primaryRuntimes(): RuntimeState[] {
  return primaryAccounts().map((a) => runtimeFor(a.ctid));
}

// Convenience: the runtime for the account the legacy single-account call sites
// (symbol/quote loading, one-off status reads) act on. Equivalent to the old
// top-level state fields; callers that need ALL trading accounts must iterate
// primaryRuntimes() instead.
export function defaultRuntime(): RuntimeState {
  return runtimeFor(primaryAccountId());
}

// Canonical-key -> this broker's ACTUAL symbol name, built lazily from symbolMap.
// This is what lets a feed name in one broker's spelling ("US TECH 100", written
// by a copy-trade source) resolve to whatever THIS broker calls the same market
// ("US100"). symbolMap is populated once per process by fetchSymbols, so the map
// is rebuilt only when its size changes.
let canonicalIndex: Map<string, string> = new Map();
let canonicalIndexSize = -1;

// Drop the cached canonical index so the next lookup rebuilds it from the current
// symbolMap. Called by fetchSymbols after (re)loading symbols, so a reconnect that
// swaps in a different list of the SAME size cannot leave a stale mapping behind.
export function invalidateSymbolResolution(): void {
  canonicalIndexSize = -1;
}

// The broker's own symbol name for whatever market `symbol` names, matched by
// canonical key across broker spellings. Returns undefined before symbols load
// or when nothing matches, so callers can fall back to their exact-name path.
export function brokerNameFor(symbol: string): string | undefined {
  if (state.symbolMap.size === 0) return undefined;
  if (canonicalIndexSize !== state.symbolMap.size) {
    const next = new Map<string, string>();
    for (const name of state.symbolMap.keys()) {
      const key = canonicalSymbolKey(name);
      // First spelling wins. Realistic broker lists carry a single symbol per
      // index token, and an exact-name match is always tried before this, so
      // this only ever fires for a genuinely cross-broker spelling.
      if (!next.has(key)) next.set(key, name);
    }
    canonicalIndex = next;
    canonicalIndexSize = state.symbolMap.size;
  }
  return canonicalIndex.get(canonicalSymbolKey(symbol));
}

// Resolve a signal/position symbol name to the broker's symbolId. Some brokers
// name a symbol without the "USD" quote suffix (e.g. "BTC" not "BTCUSD"), so we
// fall back to the stripped name, then to a cross-broker canonical match (so a
// manually typed or differently-spelled index still resolves). This MUST be the
// single resolver used by order placement, the entry gate, and the
// live-price/floating-P&L path alike: if they disagree, a position can open on a
// fallback-resolved symbol that the spot subscription then never matches,
// silently reading its floating P&L as 0.
export function symbolIdFor(symbol: string): number | undefined {
  const direct = state.symbolMap.get(symbol) ?? state.symbolMap.get(symbol.replace(/USD$/, ""));
  if (direct !== undefined) return direct;
  const broker = brokerNameFor(symbol);
  return broker !== undefined ? state.symbolMap.get(broker) : undefined;
}

// Whether a symbol's QUOTE currency is USD, which is the assumption behind the
// whole money model (risk sizing, floating P&L, daily limits). A non-USD-quoted
// pair (e.g. GBPJPY) would be valued in its quote currency and mis-read by ~the
// cross rate, so callers refuse to trade or value it. Resolved with the same
// name/stripped-USD fallback as symbolIdFor so signal names match broker names.
// Fails OPEN (returns true) until the asset+symbol lists have loaded, so a failed
// asset fetch degrades to the previous behaviour rather than halting all trading.
export function isUsdQuoted(symbol: string): boolean {
  if (state.usdQuotedSymbols.size === 0) return true;
  if (state.usdQuotedSymbols.has(symbol) || state.usdQuotedSymbols.has(symbol.replace(/USD$/, ""))) return true;
  // Same cross-broker fallback as symbolIdFor: match the canonical broker name so
  // an index arriving in another broker's spelling is still valued correctly.
  const broker = brokerNameFor(symbol);
  return broker !== undefined && state.usdQuotedSymbols.has(broker);
}

export interface AccountInfo {
  balance: number;
  equity: number;
  currency: string;
}

export function initSettings(): void {
  const saved = loadSettings();
  if (saved) {
    if (saved.allowedSymbols) state.settings.allowedSymbols = saved.allowedSymbols;
    if (saved.maxPositions) state.settings.maxPositions = saved.maxPositions;
    if (saved.maxDailyLossUSD !== undefined) state.settings.maxDailyLossUSD = saved.maxDailyLossUSD;
    if (saved.minHoldSeconds !== undefined) state.settings.minHoldSeconds = saved.minHoldSeconds;
    if (saved.riskPerTradeUSD !== undefined) state.settings.riskPerTradeUSD = saved.riskPerTradeUSD;
    if (saved.riskOverrunPercent !== undefined) state.settings.riskOverrunPercent = saved.riskOverrunPercent;
    if (saved.dailyProfitCapUSD !== undefined) state.settings.dailyProfitCapUSD = saved.dailyProfitCapUSD;
    if (saved.capBufferUSD !== undefined) state.settings.capBufferUSD = saved.capBufferUSD;
    if (saved.maxConsecutiveLosses !== undefined) state.settings.maxConsecutiveLosses = saved.maxConsecutiveLosses;
    if (saved.lossWindowMinutes !== undefined) state.settings.lossWindowMinutes = saved.lossWindowMinutes;
    if (saved.cooldownMinutes !== undefined) state.settings.cooldownMinutes = saved.cooldownMinutes;
    if (saved.reentryCooldownMinutes !== undefined) state.settings.reentryCooldownMinutes = saved.reentryCooldownMinutes;
    if (saved.maxCombinedRiskUSD !== undefined) state.settings.maxCombinedRiskUSD = saved.maxCombinedRiskUSD;
    if (saved.notifyFills !== undefined) state.settings.notifyFills = saved.notifyFills;
    if (saved.signalNotify !== undefined) state.settings.signalNotify = saved.signalNotify;
    if (saved.signalNotifyMinConfidence !== undefined) state.settings.signalNotifyMinConfidence = saved.signalNotifyMinConfidence;
    if (saved.webhookConfidence !== undefined) state.settings.webhookConfidence = saved.webhookConfidence;
    if (saved.minConfidence !== undefined) state.settings.minConfidence = saved.minConfidence;
    if (saved.marginAware !== undefined) state.settings.marginAware = saved.marginAware;
    if (saved.midnightFlatten !== undefined) state.settings.midnightFlatten = saved.midnightFlatten;
    if (saved.initialBalanceUSD !== undefined) state.settings.initialBalanceUSD = Number(saved.initialBalanceUSD) || 0;
    // staleOrderBars and the btcBias* keys were removed with their features; any
    // values left in an existing settings.json are ignored and drop out on the
    // next save.
    console.log("[STATE] Loaded saved settings. Allowed symbols:", state.settings.allowedSymbols.length);
  }

  // Restore runtime state (active cooldowns and the trading lock) so a restart
  // does not silently clear a prop-rule cooldown or a daily-limit lock. Each is
  // re-validated: time-based cooldowns are kept only if still in the future, and
  // the lock is restored only if it was set earlier the same broker day.
  // runtime.json is its own file now; fall back to the `runtime` key of the old
  // combined settings.json so an existing deployment migrates seamlessly.
  //
  // Data is staged per ctid and applied lazily the first time that account's
  // runtime is created (runtimeFor). Accounts resolve from logins after boot
  // (the ctid is not always known here), so apply-at-boot is impossible; the
  // gate and engine only run post-resolution, by which point runtimeFor has
  // hydrated every account.
  {
    const rt = loadRuntime() ?? saved?.runtime;
    if (rt) {
      const blocks = rt.accounts != null && typeof rt.accounts === "object" ? rt.accounts : (rt.tradingLocked !== undefined || rt.lossReentry ? { [String(primaryAccountId())]: rt } : null);
      if (blocks) {
        for (const [ctidStr, block] of Object.entries<any>(blocks)) {
          const ctid = Number(ctidStr);
          if (!Number.isFinite(ctid)) continue;
          restored.set(ctid, {
            tradingLocked: Boolean(block.tradingLocked),
            lockReason: block.lockReason ?? null,
            lockDay: block.lockDay ?? null,
            overrideDay: block.overrideDay ?? null,
            lossReentry: block.lossReentry && typeof block.lossReentry === "object" ? block.lossReentry : {},
            symbolCooldowns: block.symbolCooldowns && typeof block.symbolCooldowns === "object" ? block.symbolCooldowns : {},
          });
        }
      }
      console.log(`[STATE] Staged per-account runtime for ${restored.size} account(s) (applied on first use)`);
    }
  }
}

// Persisted-but-not-yet-applied per-account runtime blocks, keyed by ctid.
// Populated by initSettings, consumed (and cleared) by runtimeFor.
let restored = new Map<number, RestoredRuntime>();

interface RestoredRuntime {
  tradingLocked: boolean;
  lockReason: string | null;
  lockDay: string | null;
  overrideDay: string | null;
  lossReentry: Record<string, number>;
  symbolCooldowns: Record<string, { until: number; triggerHits: number }>;
}

// Apply one account's staged runtime block to a freshly-created RuntimeState.
// Time-based values are re-validated at apply time (the process may have
// started a while before this account's first use).
function applyRestored(ctid: number, rt: RuntimeState): void {
  const block = restored.get(ctid);
  if (!block) return;
  const now = Date.now();

  const reDur = state.settings.reentryCooldownMinutes * 60_000;
  if (reDur > 0) {
    for (const [k, t] of Object.entries(block.lossReentry)) {
      if (typeof t === "number" && t + reDur > now) rt.lossReentry.set(k, t);
    }
  }
  for (const [sym, cd] of Object.entries(block.symbolCooldowns)) {
    if (cd && typeof cd.until === "number" && cd.until > now) {
      rt.symbolCooldowns.set(sym, { until: cd.until, triggerHits: Number(cd.triggerHits) || 0 });
    }
  }
  // Lock and override are day-scoped: restore only within the same BROKER
  // trading day they were set in (dayKey, not UTC date — the broker day
  // rolls at its midnight, and that boundary owns both).
  if (block.tradingLocked && block.lockDay === dayKey()) {
    rt.tradingLocked = true;
    rt.lockReason = block.lockReason ?? null;
  }
  if (block.overrideDay === dayKey()) {
    rt.limitOverride = true;
  }

  console.log(
    `[STATE] Applied restored runtime for account ${ctid}: lock=${rt.tradingLocked}, ` +
    `${rt.lossReentry.size} re-entry cooldown(s), ${rt.symbolCooldowns.size} symbol cooldown(s)`
  );
  restored.delete(ctid);
}

// Settings and runtime persist to separate files. Settings are written ONLY on
// an explicit settings change; the frequent runtime writes (lock changes fire
// daily at the broker-day rollover) never touch settings.json — so a process
// whose in-memory settings are stale or defaulted can no longer clobber the
// user's saved configuration as a side effect of a lock update.
export function persistSettings(): void {
  saveSettings({
    allowedSymbols: state.settings.allowedSymbols,
    maxPositions: state.settings.maxPositions,
    maxDailyLossUSD: state.settings.maxDailyLossUSD,
    minHoldSeconds: state.settings.minHoldSeconds,
    riskPerTradeUSD: state.settings.riskPerTradeUSD,
    riskOverrunPercent: state.settings.riskOverrunPercent,
    dailyProfitCapUSD: state.settings.dailyProfitCapUSD,
    capBufferUSD: state.settings.capBufferUSD,
    maxConsecutiveLosses: state.settings.maxConsecutiveLosses,
    lossWindowMinutes: state.settings.lossWindowMinutes,
    cooldownMinutes: state.settings.cooldownMinutes,
    reentryCooldownMinutes: state.settings.reentryCooldownMinutes,
    maxCombinedRiskUSD: state.settings.maxCombinedRiskUSD,
    notifyFills: state.settings.notifyFills,
    signalNotify: state.settings.signalNotify,
    signalNotifyMinConfidence: state.settings.signalNotifyMinConfidence,
    webhookConfidence: state.settings.webhookConfidence,
    minConfidence: state.settings.minConfidence,
    marginAware: state.settings.marginAware,
    midnightFlatten: state.settings.midnightFlatten,
  });
}

// Persist runtime state (cooldowns, lock, limit override) for EVERY account's
// runtime to runtime.json. Call after any change to them. Format is a per-ctid
// map; legacy single-account files stay readable (initSettings migrates them).
// Staged-but-unhydrated restored blocks are written through too, so an account
// whose runtime has not been created yet (runtimeFor not reached) cannot have
// its persisted cooldowns/lock silently dropped by an early write.
export function persistRuntime(): void {
  const accounts: Record<string, unknown> = {};
  for (const [ctid, rt] of state.runtimes) {
    accounts[String(ctid)] = {
      tradingLocked: rt.tradingLocked,
      lockReason: rt.tradingLocked ? rt.lockReason : null,
      lockDay: rt.tradingLocked ? dayKey() : null,
      overrideDay: rt.limitOverride ? dayKey() : null,
      lossReentry: Object.fromEntries(rt.lossReentry),
      symbolCooldowns: Object.fromEntries(rt.symbolCooldowns),
    };
  }
  for (const [ctid, block] of restored) {
    if (!(ctid in accounts)) {
      accounts[String(ctid)] = {
        tradingLocked: block.tradingLocked,
        lockReason: block.tradingLocked ? block.lockReason : null,
        lockDay: block.tradingLocked ? block.lockDay : null,
        overrideDay: block.overrideDay ? block.overrideDay : null,
        lossReentry: block.lossReentry,
        symbolCooldowns: block.symbolCooldowns,
      };
    }
  }
  saveRuntime({ accounts });
}

// Set the daily-limit trading lock for ONE account's runtime and persist it, so
// the lock survives a restart within the same broker trading day. `reason` is a
// short human label (e.g. "Daily loss limit reached") kept for display; it is
// cleared on unlock. No-op (and no write) if nothing changed.
export function setTradingLock(rt: RuntimeState, locked: boolean, reason: string | null = null): void {
  const nextReason = locked ? reason : null;
  if (rt.tradingLocked === locked && rt.lockReason === nextReason) return;
  rt.tradingLocked = locked;
  rt.lockReason = nextReason;
  persistRuntime();
}

