import fs from "fs";
import path from "path";
import { ParsedSignal } from "./types";
import { GateResult } from "../risk/gate";

// A capped, persisted log of every signal the gate evaluated (executed or
// rejected), so the Mini App can show "what came in and why it was/wasn't
// taken". Nothing else in the bot depends on this; it is display-only.
//
// Stored newest-LAST in memory (append), served newest-FIRST. Persisted to its
// own file (not settings.json) so the log can't bloat the settings snapshot;
// writes are debounced because the poller can record several signals per tick.

const STORE_FILE = path.join(process.cwd(), "data", "signals.json");
const MAX_RECORDS = 200;
const WRITE_DEBOUNCE_MS = 1000;

export interface SignalRecord {
  receivedAt: number; // epoch ms when the gate evaluated it
  symbol: string;
  direction: "BUY" | "SELL";
  confidence: number;
  price: number;
  sl: number | null;
  tp: number | null;
  timeframe: string;
  source: string | null; // "Feed" or the channel title
  signalSource: string | null; // scanner tag, e.g. "gold_scanner"
  btcState: string | null;
  outcome: "executed" | "rejected"; // a reversal counts as executed
  reason: string | null; // rejection reason, or a note like "Reversal" for executed
}

let history: SignalRecord[] = [];
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
      if (Array.isArray(raw)) history = raw.slice(-MAX_RECORDS);
    }
  } catch (err: any) {
    console.warn(`[SIGNALS] Could not load history: ${err.message}`);
  }
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = path.dirname(STORE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(history), "utf-8");
    } catch (err: any) {
      console.warn(`[SIGNALS] Could not persist history: ${err.message}`);
    }
  }, WRITE_DEBOUNCE_MS);
}

// Append one evaluated signal. Called for EVERY signal the gate sees (feed and
// channel alike), executed or not. Trims to the newest MAX_RECORDS.
export function recordSignal(signal: ParsedSignal, result: GateResult): void {
  load();
  history.push({
    receivedAt: Date.now(),
    symbol: signal.symbol,
    direction: signal.direction,
    confidence: signal.confidence ?? 0,
    price: signal.price,
    sl: signal.sl ?? null,
    tp: signal.tp ?? null,
    timeframe: signal.timeframe,
    source: signal.source ?? null,
    signalSource: signal.signalSource ?? null,
    btcState: signal.btcState ?? null,
    outcome: result.accepted ? "executed" : "rejected",
    // For an accepted reversal the gate returns a note; a plain execution has none.
    reason: result.reason ?? null,
  });
  if (history.length > MAX_RECORDS) history = history.slice(-MAX_RECORDS);
  scheduleWrite();
}

// The log, newest first, for the Mini App.
export function getSignalHistory(): SignalRecord[] {
  load();
  return [...history].reverse();
}
