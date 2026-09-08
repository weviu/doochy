import fs from "fs";
import path from "path";
import { state, primaryRuntimes, RuntimeState } from "../state";
import { closePosition } from "./midnightClose";
import { notify } from "../bot/notify";
import { DATA_DIR } from "../paths";
import { writeJsonAtomic } from "../storage";

// Time-based exit for gold (XAUUSD / gold_scanner). The Connors-RSI(2) mean-
// reversion edge is time-bounded, so a position opened from an alert carrying
// `time_exit_min > 0` is market-closed once its hold window elapses (wall-clock
// minutes from FILL), regardless of P&L. The protective SL/TP stay armed the whole
// time - whichever of SL, TP, or the timer fires first closes the position; the
// timer never touches the stop. Anything without an in-scope time_exit_min behaves
// exactly as before (SL/TP only).
//
// Multi-account: each traded account has its own store entries, keyed
// "${ctid}:${positionId}", and its own monitor tick (a timer on account A must
// never close a position with the same id on account B).

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface TimeExitConfig {
  maxTimeExitMin: number; // safety cap: clamp any absurd feed value to this
  symbols: string[]; // instruments the time exit applies to
  sources: string[]; // signal_source values in scope ([] = any source)
}

export const DEFAULT_TIME_EXIT_CONFIG: TimeExitConfig = {
  maxTimeExitMin: 1440, // 24h
  symbols: ["XAUUSD"],
  sources: ["gold_scanner"],
};

const CONFIG_FILE = path.join(DATA_DIR, "time-exit-config.json");
let config: TimeExitConfig = { ...DEFAULT_TIME_EXIT_CONFIG };

// Load overrides from data/time-exit-config.json if present (partial file just
// tweaks a few knobs). Never throws.
export function loadTimeExitConfig(): TimeExitConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const merged: TimeExitConfig = { ...DEFAULT_TIME_EXIT_CONFIG };
      for (const key of Object.keys(DEFAULT_TIME_EXIT_CONFIG) as Array<keyof TimeExitConfig>) {
        if (raw[key] !== undefined) (merged as any)[key] = raw[key];
      }
      config = merged;
      console.log(`[timeexit] config loaded from ${CONFIG_FILE}`);
    }
  } catch (err: any) {
    console.warn(`[timeexit] could not load ${CONFIG_FILE}, using defaults: ${err.message}`);
    config = { ...DEFAULT_TIME_EXIT_CONFIG };
  }
  return config;
}

export function getTimeExitConfig(): TimeExitConfig {
  return config;
}

export function setTimeExitConfig(cfg: Partial<TimeExitConfig>): TimeExitConfig {
  config = { ...config, ...cfg };
  return config;
}

// The effective time-exit for a signal: 0 (no time exit) unless the symbol AND
// source are in scope and the raw value is a positive number; otherwise the raw
// value clamped to [1, maxTimeExitMin]. Scoping here means a stray time_exit_min on
// some other source/symbol can never accidentally activate the timer.
export function effectiveTimeExitMin(
  symbol: string,
  source: string | undefined,
  rawMin: number | null | undefined,
  cfg: TimeExitConfig = config
): number {
  if (rawMin == null || !Number.isFinite(rawMin) || rawMin <= 0) return 0;
  if (!cfg.symbols.includes(symbol)) return 0;
  if (cfg.sources.length > 0 && !(source != null && cfg.sources.includes(source))) return 0;
  return Math.min(Math.floor(rawMin), cfg.maxTimeExitMin);
}

// Expiry (ms from placement) for a RESTING order, folding in the time exit: a
// time-exit signal's resting order must not fill past its hold window, so cap its
// expiry at time_exit_min from placement. Whichever expiry is shorter wins; 0 stays
// 0 (good-till-cancel) only when there's no time exit either. Pure, for testability.
export function restingExpiryMs(staleMs: number, timeExitMin: number): number {
  if (timeExitMin <= 0) return staleMs;
  const timedMs = timeExitMin * 60_000;
  return staleMs > 0 ? Math.min(staleMs, timedMs) : timedMs;
}

// ---------------------------------------------------------------------------
// Persistent timer store (survives restart; positions themselves are rebuilt from
// the broker, which does not return our time_exit_min metadata).
// ---------------------------------------------------------------------------
interface TimerEntry {
  symbol: string;
  timeExitMin: number;
  fillTime: number; // epoch ms of the actual fill
}

const STORE_FILE = path.join(DATA_DIR, "time-exits.json");
let store: Record<string, TimerEntry> = {};
let loaded = false;

function loadStore(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
      if (raw && typeof raw === "object") store = raw;
    }
  } catch (err: any) {
    console.warn(`[timeexit] could not read store: ${err.message}`);
  }
}

function persistStore(): void {
  try {
    writeJsonAtomic(STORE_FILE, store, 0);
  } catch (err: any) {
    console.warn(`[timeexit] could not write store: ${err.message}`);
  }
}

function keyFor(ctid: number, positionId: number): string {
  return `${ctid}:${positionId}`;
}

// Every timer entry that belongs to ONE account, as [positionId, entry] pairs.
// Prefixed keys match directly; a purely-legacy bare-key store (no prefixed keys
// at all) is attributed to this account - the single-account migration case.
function entriesFor(ctid: number): [number, TimerEntry][] {
  loadStore();
  const prefix = `${ctid}:`;
  const out: [number, TimerEntry][] = [];
  let sawPrefixed = false;
  const bare: [number, TimerEntry][] = [];
  for (const [k, e] of Object.entries(store)) {
    if (k.startsWith(prefix)) {
      out.push([Number(k.slice(prefix.length)), e]);
      sawPrefixed = true;
    } else if (!k.includes(":")) {
      bare.push([Number(k), e]);
    }
  }
  if (sawPrefixed) return out;
  return bare;
}

// Record a timed position at fill. Called from the order fill handlers with the
// broker fill time. No-op when timeExitMin <= 0 (not a timed position).
export function recordTimedPosition(ctid: number, positionId: number, symbol: string, timeExitMin: number, fillTime: number): void {
  if (timeExitMin <= 0) return;
  loadStore();
  store[keyFor(ctid, positionId)] = { symbol, timeExitMin, fillTime };
  persistStore();
  const expiry = new Date(fillTime + timeExitMin * 60_000).toISOString();
  console.log(`[timeexit] armed #${positionId} ${symbol} (account ${ctid}): ${timeExitMin}m from fill -> close ~${expiry}`);
}

// Forget a timed position (it closed for any reason: SL, TP, timer, news flatten,
// manual, stop-out). Idempotent. Called from every position-close path. Also
// removes a legacy bare-key entry for the same position id.
export function clearTimedPosition(ctid: number, positionId: number): void {
  loadStore();
  let changed = false;
  if (store[keyFor(ctid, positionId)]) {
    delete store[keyFor(ctid, positionId)];
    changed = true;
  }
  if (store[String(positionId)]) {
    delete store[String(positionId)];
    changed = true;
  }
  if (changed) persistStore();
}

export function timerFor(ctid: number, positionId: number): TimerEntry | undefined {
  loadStore();
  return store[keyFor(ctid, positionId)] ?? store[String(positionId)];
}

// The traded accounts a boot-time restore or a monitor tick should act on: the
// primary accounts normally; falling back to whatever runtimes exist when the
// registry has not been resolved (test contexts), so a pre-resolution caller
// still sees hydrated state.
function runtimesToActOn(): RuntimeState[] {
  const primaries = primaryRuntimes();
  if (primaries.length > 0) return primaries;
  return [...state.runtimes.values()];
}

// After boot reconcile, re-attach the persisted timeExitMin to any still-open
// position so /positions and the monitor see it. Does NOT prune entries merely
// absent from state.positions: a reconcile can legitimately fail (CANT_ROUTE_
// REQUEST) and return nothing, and wiping timers then would leave a position to
// hold past its window (the exact restart bug we must avoid). Only truly ancient
// orphans (well past their expiry) are pruned as a safety valve.
export function restoreTimedPositions(): void {
  loadStore();
  const now = Date.now();
  let reattached = 0;
  let pruned = 0;
  for (const rt of runtimesToActOn()) {
    for (const [pid, entry] of entriesFor(rt.ctid)) {
      const key = keyFor(rt.ctid, pid);
      // Migrate a legacy bare-key entry to this account's prefixed key so a
      // second account can never double-claim it.
      if (store[String(pid)] && !store[key]) {
        store[key] = entry;
        delete store[String(pid)];
      }
      const pos = rt.positions.get(pid);
      if (pos) {
        pos.timeExitMin = entry.timeExitMin;
        // Trust the persisted fill time as authoritative (broker openTimestamp can
        // drift or be absent); align the position's openTime to it so display + timer
        // agree.
        if (entry.fillTime > 0) pos.openTime = entry.fillTime;
        reattached++;
        const due = new Date(entry.fillTime + entry.timeExitMin * 60_000).toISOString();
        console.log(`[timeexit] restored timer for #${pid} ${entry.symbol} (account ${rt.ctid}): due ${due}`);
      } else {
        // Safety-valve prune: gone from the book AND more than a full extra window
        // past due, so it can't be a position hiding behind a failed reconcile.
        const graceMs = (entry.timeExitMin + config.maxTimeExitMin) * 60_000;
        if (now > entry.fillTime + graceMs) {
          delete store[key];
          pruned++;
        }
      }
    }
  }
  if (pruned) persistStore();
  console.log(`[timeexit] restore: ${reattached} timer(s) re-attached, ${pruned} stale entry(ies) pruned, ${Object.keys(store).length} tracked`);
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------
const TICK_MS = 30_000; // check the timers twice a minute (minute-level precision)
// positionIds with a close request in progress, per account (ids can collide
// across accounts, so key by `${ctid}:${positionId}`).
const inFlight = new Set<string>();

// True once now is at/after fillTime + timeExitMin.
function isExpired(entry: TimerEntry, now: number): boolean {
  return now >= entry.fillTime + entry.timeExitMin * 60_000;
}

async function tickForAccount(rt: RuntimeState): Promise<void> {
  loadStore();
  const now = Date.now();

  for (const [pid, entry] of entriesFor(rt.ctid)) {
    const key = `${rt.ctid}:${pid}`;
    if (inFlight.has(key)) continue; // a close is already being attempted
    const pos = rt.positions.get(pid);
    if (!pos) continue; // not open here (closed, or reconcile hasn't repopulated it)
    if (!isExpired(entry, now)) continue;

    inFlight.add(key);
    const overdueMin = Math.round((now - (entry.fillTime + entry.timeExitMin * 60_000)) / 60_000);
    console.log(`[timeexit] #${pid} ${entry.symbol} (account ${rt.ctid}) reached its ${entry.timeExitMin}m hold window (overdue ${overdueMin}m) - closing at market`);
    try {
      const ok = await closePosition(rt, pid);
      if (ok) {
        // closePosition removed it from rt.positions; forget the timer too so no
        // later tick re-issues it and a re-opened position isn't closed by this timer.
        clearTimedPosition(rt.ctid, pid);
        const msg = `Time exit: closed ${entry.symbol} #${pid} at market after ${entry.timeExitMin}m hold`;
        console.log(`[timeexit] ${msg}`);
        if (state.settings.notifyFills) notify(msg);
      } else {
        // Close failed - most likely the market is closed (gold weekend). Leave the
        // timer in place; the next tick retries and closes at the reopen tick. Do
        // NOT drop the entry, so we never silently hold past the window.
        console.warn(`[timeexit] close of #${pid} ${entry.symbol} failed (market closed?) - will retry, closing at reopen`);
      }
    } catch (err: any) {
      console.warn(`[timeexit] error closing #${pid} ${entry.symbol}: ${err.message} - will retry`);
    } finally {
      inFlight.delete(key);
    }
  }
}

// Start the time-exit monitor. Call once at boot AFTER reconcilePositions() and
// restoreTimedPositions() so the broker connection is wired and timers are loaded.
// Ticks every traded account: each has its own timers and its own open book.
export function startTimeExitMonitor(): void {
  setInterval(() => {
    for (const rt of primaryRuntimes()) {
      tickForAccount(rt).catch((err) => console.warn(`[timeexit] tick error: ${err.message}`));
    }
  }, TICK_MS);
  console.log(`[timeexit] monitor active (tick ${TICK_MS / 1000}s, ${Object.keys(store).length} timer(s) tracked)`);
}

// Test hook: reset in-memory store deterministically.
export function _resetForTest(entries: Record<string, TimerEntry> = {}): void {
  store = { ...entries };
  loaded = true;
  inFlight.clear();
}

export function _tickForTest(rt: RuntimeState): Promise<void> {
  return tickForAccount(rt);
}