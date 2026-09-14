import { loadSettings, loadSettingsBlock, saveSettingsBlock, GLOBAL_KEY, loadRuntime, saveRuntime } from "./storage";
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
  // Where this position came from. "Manual" marks a position opened in the
  // cTrader platform on a symbol the bot does NOT trade (picked up by reconcile
  // so the account's real book is visible). Manual positions are DISPLAY-ONLY:
  // isManualPosition() gates every managing monitor — the daily-loss engine, SL
  // watchdog, time-exit, midnight and news flattens, the position gate
  // (maxPositions / one-per-symbol / combined risk) and /closeall all skip
  // them, so they stay entirely the user's to manage. Positions on the bot's
  // own symbols carry the feed/channel label; rebuilt positions (reconcile
  // after a restart) have no source, since the broker doesn't know who asked.
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

// True for a position the bot did not open (opened in the cTrader platform on a
// symbol outside the bot's allowed set). Display-only: every monitor that
// MANAGES the book — force-close, SL watchdog amend, time-exit, midnight and
// news flatten, /closeall, and the entry gate's position limits — routes through
// this check so a manual trade is never closed, amended, or counted against the
// bot's own slots. It still appears in /status, /positions and the mini-app.
export function isManualPosition(pos: Position): boolean {
  return pos.source === "Manual";
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
  // shared, broker/feed-level fields (settings, signal dedupe stamps) stay on
  // the singleton.
  runtimes: Map<number, RuntimeState>;
  lastSignalTime: Map<string, number>;
  // Per-account symbol spaces, keyed by ctidTraderAccountId: each account's
  // broker maps its own symbol names -> symbolIds (accounts can live on
  // different environments/brokers, so symbol ids are NOT shared). Populated by
  // fetchSymbols per account; resolvers below read the account's own space.
  accountSymbols: Map<number, AccountSymbolSpace>;
}

export interface AccountSymbolSpace {
  // broker symbol name (upper) -> symbolId. int64 ids coerced to Number.
  ids: Map<string, number>;
  // names whose QUOTE currency is USD. The money model (risk sizing, floating
  // P&L, daily limits) is exact for these; a non-USD-quoted pair is valued via
  // quoteToUsd() instead. Empty until the asset+symbol lists load (then
  // isUsdQuoted fails open).
  usd: Set<string>;
  // name -> its QUOTE currency asset name ("USD","JPY","CAD",...). Drives
  // quoteToUsd() so a non-USD-quoted symbol's P&L/risk can be converted into USD
  // via the matching conversion pair (USDJPY/USDCAD/etc).
  quote: Map<string, string>;
  // symbols that exist in the full list but are not enabled for trading on this
  // specific account (enabled:false in ProtoOASymbolsListReq). Filtered out by
  // the "add all available" flow so users don't see instruments their account
  // type can't trade.
  disabled: Set<string>;
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
  // Per-account trading pause: an account can be paused independently of the
  // others (mini-app pause/scoping; Telegram /pause <account>). The global
  // state.paused is the "pause all" master switch on top of this; an account
  // trades only when neither the master nor its own pause is set.
  paused: boolean;
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
  // This account's own settings: a COPY (never the shared state.settings
  // object), seeded from the global defaults at hydration and overlaid with the
  // account's persisted "per-account" block. The 4 process-global fields
  // (notifyFills, signalNotify, signalNotifyMinConfidence, webhookConfidence)
  // are ignored here — the gate, engine, and monitors read them from
  // state.settings, and settingsSnapshot re-merges them for display.
  settings: BotSettings;
}

// Which settings are process-global (shared across every traded account) vs
// per-account. The per-account ones live in each account's settings.json block
// ("<ctid>") and hydrate that account's runtime.settings; the global ones live
// under GLOBAL_KEY ("global") and stay authoritative on state.settings (re-read
// live through settingsSnapshot on the way out, so a notification change is
// never stale in a snapshot).
export const GLOBAL_SETTING_KEYS = [
  "notifyFills",
  "signalNotify",
  "signalNotifyMinConfidence",
  "webhookConfidence",
] as const;

export const PER_ACCOUNT_SETTING_KEYS = [
  "allowedSymbols",
  "maxPositions",
  "maxDailyLossUSD",
  "minHoldSeconds",
  "riskPerTradeUSD",
  "riskOverrunPercent",
  "dailyProfitCapUSD",
  "capBufferUSD",
  "maxConsecutiveLosses",
  "lossWindowMinutes",
  "cooldownMinutes",
  "reentryCooldownMinutes",
  "maxCombinedRiskUSD",
  "minConfidence",
  "marginAware",
  "midnightFlatten",
  "initialBalanceUSD",
] as const;

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
  accountSymbols: new Map(),
};

function freshRuntime(ctid: number): RuntimeState {
  return {
    ctid,
    paused: false,
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
    settings: { ...DEFAULT_SETTINGS },
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
    applySettings(ctid, rt);
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

// The account a no-ctid resolver acts on. Keeps the ~dozen legacy call sites
// (parser, gate, symbol commands) working unchanged: they all act on "the"
// account, which is the first primary. Trading-path resolvers pass rt.ctid so
// each account resolves against its OWN broker's symbol space.
function defaultCtid(): number {
  return primaryAccountId();
}

// The settings ONE account trades under. Never the shared state.settings object
// directly: account settings are snapshotted per runtime (seeded from
// state.settings's defaults, then overlaid with the account's own persisted
// block), so mutating one account's setting can't leak into the others. No ctid
// = the default (first primary) account.
export function settingsFor(ctid?: number): BotSettings {
  return runtimeFor(ctid ?? defaultCtid()).settings;
}

// A full settings object for one account with the process-global fields read
// LIVE from state.settings (they change without touching any account's block —
// /notifications, /risk confidence — so state.settings must stay authoritative),
// so a snapshot is always current. This is what commands, the hub relay, and
// the mini-app see.
export function settingsSnapshot(ctid?: number): BotSettings {
  return {
    ...settingsFor(ctid),
    notifyFills: state.settings.notifyFills,
    signalNotify: state.settings.signalNotify,
    signalNotifyMinConfidence: state.settings.signalNotifyMinConfidence,
    webhookConfidence: state.settings.webhookConfidence,
  };
}

// The symbol space for one account, created empty on first use so resolvers can
// return "not found" before fetchSymbols has run for that account.
export function symbolSpaceFor(ctid: number): AccountSymbolSpace {
  let space = state.accountSymbols.get(ctid);
  if (!space) {
    space = { ids: new Map(), usd: new Set(), quote: new Map(), disabled: new Set() };
    state.accountSymbols.set(ctid, space);
  }
  return space;
}

export function clearAccountSymbols(ctid?: number): void {
  if (ctid !== undefined) { state.accountSymbols.delete(ctid); return; }
  state.accountSymbols.clear();
}

// Canonical-key -> this broker's ACTUAL symbol name for ONE account, built lazily
// from that account's symbol space. This is what lets a feed name in one broker's
// spelling ("US TECH 100", written by a copy-trade source) resolve to whatever
// THIS broker calls the same market ("US100"). Rebuilt when the space's size
// changes. keyed by ctid: each account's broker may spell a market differently.
const canonicalIndexes = new Map<number, { index: Map<string, string>; size: number }>();

// Drop the cached canonical index/es so the next lookup rebuilds from the current
// symbol space. Called by fetchSymbols after (re)loading symbols, so a reconnect
// that swaps in a different list of the SAME size cannot leave a stale mapping.
export function invalidateSymbolResolution(ctid?: number): void {
  if (ctid !== undefined) {
    const c = canonicalIndexes.get(ctid);
    if (c) c.size = -1;
    return;
  }
  for (const c of canonicalIndexes.values()) c.size = -1;
}

// The broker's own symbol name for whatever market `symbol` names on ONE account,
// matched by canonical key across broker spellings. Returns undefined before the
// account's symbols load or when nothing matches, so callers can fall back to
// their exact-name path.
export function brokerNameFor(symbol: string, ctid?: number): string | undefined {
  const target = ctid ?? defaultCtid();
  const space = state.accountSymbols.get(target);
  if (!space || space.ids.size === 0) return undefined;
  let entry = canonicalIndexes.get(target);
  if (!entry || entry.size !== space.ids.size) {
    const index = new Map<string, string>();
    for (const name of space.ids.keys()) {
      const key = canonicalSymbolKey(name);
      // First spelling wins. Realistic broker lists carry a single symbol per
      // index token, and an exact-name match is always tried before this, so
      // this only ever fires for a genuinely cross-broker spelling.
      if (!index.has(key)) index.set(key, name);
    }
    entry = { index, size: space.ids.size };
    canonicalIndexes.set(target, entry);
  }
  return entry.index.get(canonicalSymbolKey(symbol));
}

// Resolve a signal/position symbol name to the broker's symbolId on ONE account.
// Some brokers name a symbol without the "USD" quote suffix (e.g. "BTC" not
// "BTCUSD"), so we fall back to the stripped name, then to a cross-broker
// canonical match (so a manually typed or differently-spelled index still
// resolves). This MUST be the single resolver used by order placement, the entry
// gate, and the live-price/floating-P&L path alike: if they disagree, a position
// can open on a fallback-resolved symbol that the spot subscription then never
// matches, silently reading its floating P&L as 0. Each account resolves against
// its OWN space (accounts on different brokers can legitimately disagree).
export function symbolIdFor(symbol: string, ctid?: number): number | undefined {
  const target = ctid ?? defaultCtid();
  const space = state.accountSymbols.get(target);
  if (!space) return undefined;
  const direct = space.ids.get(symbol) ?? space.ids.get(symbol.replace(/USD$/, ""));
  if (direct !== undefined) return direct;
  const broker = brokerNameFor(symbol, target);
  return broker !== undefined ? space.ids.get(broker) : undefined;
}

// Whether a symbol's QUOTE currency is USD on ONE account, which is the
// assumption behind the whole money model (risk sizing, floating P&L, daily
// limits). A non-USD-quoted pair (e.g. GBPJPY) would be valued in its quote
// currency and mis-read by ~the cross rate, so callers refuse to trade or value
// it. Resolved with the same name/stripped-USD fallback as symbolIdFor so
// signal names match broker names. Fails OPEN (returns true) until the
// asset+symbol lists have loaded for that account, so a failed asset fetch
// degrades to the previous behaviour rather than halting all trading.
export function isUsdQuoted(symbol: string, ctid?: number): boolean {
  const target = ctid ?? defaultCtid();
  const space = state.accountSymbols.get(target);
  if (!space || space.usd.size === 0) return true;
  if (space.usd.has(symbol) || space.usd.has(symbol.replace(/USD$/, ""))) return true;
  // Same cross-broker fallback as symbolIdFor: match the canonical broker name so
  // an index arriving in another broker's spelling is still valued correctly.
  const broker = brokerNameFor(symbol, target);
  return broker !== undefined && space.usd.has(broker);
}

// The QUOTE currency asset name for a symbol on ONE account ("USD","JPY",...),
// used to pick the USD conversion pair. Undefined until symbols load.
export function quoteCurrencyFor(symbol: string, ctid?: number): string | undefined {
  const target = ctid ?? defaultCtid();
  const space = state.accountSymbols.get(target);
  if (!space) return undefined;
  return space.quote.get(symbol) ?? space.quote.get(symbol.replace(/USD$/, ""));
}

// Reverse lookup: the broker's symbol NAME for a symbolId on ONE account.
export function symbolNameById(ctid: number, symbolId: number): string {
  const space = state.accountSymbols.get(ctid);
  if (space) {
    const target = String(symbolId);
    for (const [name, id] of space.ids) {
      if (String(id) === target) return name;
    }
  }
  return `#${symbolId}`;
}

// Every tradable symbol NAME on one account (disabled ones excluded), for
// commands that enumerate the broker's list.
export function enabledSymbolNames(ctid?: number): string[] {
  const space = state.accountSymbols.get(ctid ?? defaultCtid());
  return space ? [...space.ids.keys()] : [];
}

export interface AccountInfo {
  balance: number;
  equity: number;
  currency: string;
}

export function initSettings(): void {
  // settings.json is now a per-key map: GLOBAL_KEY ("global") holds the handful
  // of process-global settings; each numeric top-level key holds ONE account's
  // per-account settings. Legacy flat files (all fields at top level, no
  // "global" and no numeric keys) are left untouched and IGNORED — no migration,
  // new deployments start from defaults — so an old deployment's saved state is
  // never misread as new per-account state. (The global fields COULD be read
  // from a legacy file, but blending two formats makes the start-fresh guarantee
  // hard to reason about; the user opted to start clean.)
  const file = loadSettings();
  if (file && typeof file === "object") {
    const global = loadSettingsBlock(GLOBAL_KEY);
    if (global) {
      if (typeof global.notifyFills === "boolean") state.settings.notifyFills = global.notifyFills;
      if (typeof global.signalNotify === "boolean") state.settings.signalNotify = global.signalNotify;
      if (typeof global.signalNotifyMinConfidence === "number") state.settings.signalNotifyMinConfidence = global.signalNotifyMinConfidence;
      if (typeof global.webhookConfidence === "number") state.settings.webhookConfidence = global.webhookConfidence;
      console.log(`[STATE] Loaded global settings (notifyFills=${state.settings.notifyFills}, signalNotify=${state.settings.signalNotify}, signalNotifyMinConfidence=${state.settings.signalNotifyMinConfidence}, webhookConfidence=${state.settings.webhookConfidence})`);
    }

    // Per-account blocks: every top-level key whose name is a ctid number. Each
    // is picked to its per-account fields (unknown/global keys are dropped) and
    // staged for applySettings, which overlays it on the account's runtime the
    // first time that account is touched. Accounts do NOT resolve at boot, so
    // apply-at-boot is impossible; the gate and engine only run post-resolution,
    // by which point runtimeFor has hydrated every account.
    const staged: string[] = [];
    const ignoredLegacy: string[] = [];
    for (const [key, block] of Object.entries<any>(file)) {
      if (key === GLOBAL_KEY) continue;
      const ctid = Number(key);
      if (Number.isFinite(ctid) && block && typeof block === "object") {
        stagedSettings.set(ctid, pick(block, PER_ACCOUNT_SETTING_KEYS));
        staged.push(key);
      } else {
        ignoredLegacy.push(key);
      }
    }
    if (staged.length) {
      console.log(`[STATE] Staged per-account settings for ${staged.length} account(s) (applied on first use): ${staged.join(", ")}`);
    }
    if (ignoredLegacy.length) {
      console.warn(
        `[STATE] Ignoring ${ignoredLegacy.length} legacy top-level settings key(s): ${ignoredLegacy.join(", ")}. ` +
        "Settings are now keyed per account in settings.json; start fresh with /risk, /symbols, /minhold, /balance."
      );
    }
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
    const rt = loadRuntime() ?? loadSettings()?.runtime;
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

// Persisted-but-not-yet-applied per-account setting blocks, keyed by ctid.
// Populated by initSettings from each numeric key in settings.json; consumed
// (and cleared) by applySettings on the account's first runtimeFor().
let stagedSettings = new Map<number, Partial<BotSettings>>();

// Copy only a named subset of fields from a raw settings.json block, so a
// hand-edited or future file can't smuggle global keys into an account's runtime
// (they belong under GLOBAL_KEY on state.settings and would be shadowed anyway).
function pick(block: Record<string, any>, keys: readonly string[]): Partial<BotSettings> {
  const out: Partial<BotSettings> = {};
  for (const k of keys) {
    if (block[k] !== undefined) (out as any)[k] = block[k];
  }
  return out;
}

// Apply ONE account's staged settings block to a freshly-created RuntimeState:
// seed from the global defaults, then overlay the account's own persisted
// per-account block. The account's runtime.settings is always a COPY, so two
// accounts pointing at different state never share an object.
function applySettings(ctid: number, rt: RuntimeState): void {
  const block = stagedSettings.get(ctid);
  rt.settings = block ? { ...state.settings, ...block } : { ...state.settings };
  if (block) stagedSettings.delete(ctid);
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

  const reDur = rt.settings.reentryCooldownMinutes * 60_000;
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
//
// Writes are split by scope: persistGlobalSettings() writes the process-global
// block under GLOBAL_KEY; persistAccountSettings(ctid) writes ONE account's
// per-account block under "<ctid>". Neither rewrites the whole file from a
// potentially stale in-memory copy the way the old flat persistSettings() did.
export function persistGlobalSettings(): void {
  saveSettingsBlock(GLOBAL_KEY, pick(state.settings, GLOBAL_SETTING_KEYS) as Record<string, any>);
}

// Persist ONE account's per-account settings (read from its own runtime, so a
// fresh in-memory change is captured) to settings.json under "<ctid>".
export function persistAccountSettings(ctid: number): void {
  saveSettingsBlock(String(ctid), pick(settingsFor(ctid), PER_ACCOUNT_SETTING_KEYS) as Record<string, any>);
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

