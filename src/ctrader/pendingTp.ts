import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { writeJsonAtomic } from "../storage";

// Persistent store of TAKE-PROFITS that are waiting out the prop-firm min-hold.
//
// When a position fills, its SL is armed immediately but the TP is deliberately
// withheld until the min-hold elapses (anti-scalping rule), then applied by an
// in-memory setTimeout. A process restart during that window loses the timer, and
// reconcile CANNOT recover the intended TP level - the broker doesn't echo our
// signal's TP, so the position would be left SL-only until manually managed.
//
// This store persists the pending TP so a restart can re-arm it (see
// restorePendingTps in amend.ts). It mirrors the time-exit store's design: a tiny
// JSON file, best-effort I/O that never throws, cleared on every position close.
export interface PendingTp {
  symbol: string;
  direction: "BUY" | "SELL";
  sl: number | null; // re-sent with the TP amend (amend replaces the full SL/TP state)
  tp: number;
  holdDeadline: number; // epoch ms at/after which the TP may be applied (openTime + minHold)
}

const STORE_FILE = path.join(DATA_DIR, "pending-tps.json");
let store: Record<string, PendingTp> = {};
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
    console.warn(`[pendingtp] could not read store: ${err.message}`);
  }
}

function persistStore(): void {
  try {
    writeJsonAtomic(STORE_FILE, store, 0);
  } catch (err: any) {
    console.warn(`[pendingtp] could not write store: ${err.message}`);
  }
}

// Record a TP awaiting the min-hold. Called when the deferred amend is scheduled.
export function recordPendingTp(positionId: number, entry: PendingTp): void {
  loadStore();
  store[String(positionId)] = entry;
  persistStore();
}

// Forget a pending TP (it was applied, or the position closed for any reason).
// Idempotent; called from applyDeferredTp and from every position-close path.
export function clearPendingTp(positionId: number): void {
  loadStore();
  if (store[String(positionId)]) {
    delete store[String(positionId)];
    persistStore();
  }
}

// Every persisted pending TP, as [positionId, entry] pairs. Used by the boot-time
// restore to re-arm timers after a restart.
export function allPendingTps(): [number, PendingTp][] {
  loadStore();
  return Object.entries(store).map(([id, e]) => [Number(id), e]);
}

// Test hook: reset the in-memory store deterministically.
export function _resetForTest(entries: Record<string, PendingTp> = {}): void {
  store = { ...entries };
  loaded = true;
}
