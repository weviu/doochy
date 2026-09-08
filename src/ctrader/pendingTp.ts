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
//
// Multi-account: position ids can collide across traded accounts, so entries are
// keyed "${ctid}:${positionId}". A legacy bare-key store (written before the
// accounts split) is still readable: bare keys are attributed to the first
// account that reads them when the store carries no prefixed keys at all.
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

function keyFor(ctid: number, positionId: number): string {
  return `${ctid}:${positionId}`;
}

// Record a TP awaiting the min-hold. Called when the deferred amend is scheduled.
export function recordPendingTp(ctid: number, positionId: number, entry: PendingTp): void {
  loadStore();
  store[keyFor(ctid, positionId)] = entry;
  persistStore();
}

// Forget a pending TP (it was applied, or the position closed for any reason).
// Idempotent; called from applyDeferredTp and from every position-close path.
// Also removes a legacy bare-key entry for the same position id.
export function clearPendingTp(ctid: number, positionId: number): void {
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

// Every persisted pending TP for ONE account, as [positionId, entry] pairs.
// Prefixed keys match directly; a purely-legacy bare-key store (no prefixed keys
// at all) is attributed to this account - the single-account migration case.
// Used by the boot-time restore to re-arm timers after a restart.
export function pendingTpsForAccount(ctid: number): [number, PendingTp][] {
  loadStore();
  const prefix = `${ctid}:`;
  const out: [number, PendingTp][] = [];
  let sawPrefixed = false;
  const bare: [number, PendingTp][] = [];
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

// Total pending-TP count across every account, for diagnostics.
export function allPendingTpsCount(): number {
  loadStore();
  return Object.keys(store).length;
}

// Test hook: reset the in-memory store deterministically.
export function _resetForTest(entries: Record<string, PendingTp> = {}): void {
  store = { ...entries };
  loaded = true;
}