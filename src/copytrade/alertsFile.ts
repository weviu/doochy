import fs from "fs";
import path from "path";

// Writes copy-trade alerts into the SAME alerts.json the signal scanner writes,
// in the same schema, so they flow through the existing feed-server -> poller ->
// doochybot pipeline with zero downstream changes.
//
// Two properties of the existing pipeline dictate how this file is written:
//
//  1. NEWEST-FIRST. poller.ts does `alerts.filter(a => a.timestamp > lastTimestamp)`
//     and seeds its cursor from alerts[0]. New entries must be PREPENDED; an entry
//     appended to the end sits below the cursor and never fires.
//
//  2. SECOND-PRECISION STRING COMPARISON. Timestamps are "YYYY-MM-DD HH:MM:SS"
//     and are compared as strings with STRICTLY-greater. An alert sharing a second
//     with the poller's cursor is therefore invisible forever - silently, with no
//     error anywhere. See uniqueTimestamp() for how that is avoided.
//
// The scanner writes this same file, so every write is read-modify-write via a
// temp file + atomic rename: a reader never observes a partial array, and a
// crash mid-write leaves the original intact.

// Resolved per call, not captured at module load, so it always reflects the
// current environment rather than whatever was set when the import was hoisted.
function alertsFile(): string {
  return process.env.COPYTRADE_ALERTS_FILE
    || path.join(process.cwd(), "scanner", "data", "alerts.json");
}

// The scanner emits `timestamp` in UTC and `timestamp_local` at UTC+3 (the
// operator's own timezone, kept so the feed is readable while debugging). This
// host runs UTC, so the offset cannot be derived from the system clock - it is
// fixed here to match what the scanner produces.
const LOCAL_OFFSET_HOURS = 3;

// The on-disk feed row. Deliberately a separate shape from RawAlert (the parsed
// view doochybot consumes): this is the wire format, including the fields the
// parser ignores (timestamp_local, src_bar). Where they overlap the types must
// agree - `rsi: number | null` here matches RawAlert.rsi for exactly that reason.
export interface CopyAlert {
  timestamp: string;
  timestamp_local: string;
  symbol: string;
  timeframe: string | null;
  direction: "buy" | "sell";
  rsi: number | null;
  price: number;
  current_price: number;
  pivot_level: string | null;
  pivot_distance: number | null;
  confidence: number;
  sl: number | null;
  tp: number | null;
  time_exit_min: number | null;
  src_bar: string | null;
  btc_state: string | null;
  signal_source: string;
}

// "YYYY-MM-DD HH:MM:SS" - the scanner's exact format: space separated, second
// precision, no timezone suffix, no sub-second component.
function format(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function readAlerts(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch (err: any) {
    // Re-throw: writing a fresh array over a file we failed to parse would
    // destroy the scanner's alerts. The caller logs and skips this alert.
    throw new Error(`could not read alerts feed: ${err.message}`);
  }
}

// Find a timestamp no existing entry already uses, scanning FORWARD one second at
// a time until a genuinely free second is found.
//
// A single collision test is not enough: bumping 12:00:01 -> 12:00:02 can land on
// another existing entry, so this keeps advancing until the second is unused. The
// cost is a timestamp up to a few seconds later than the true fill, which is
// immaterial for a position held against a fixed TP/SL - and far better than the
// alternative, where a same-second collision makes the alert permanently
// unpickable by the poller's strictly-greater cursor.
function uniqueTimestamp(desired: Date, existing: any[]): Date {
  const taken = new Set<string>();
  for (const a of existing) {
    if (a && typeof a.timestamp === "string") taken.add(a.timestamp);
  }
  const out = new Date(desired.getTime());
  let guard = 0;
  while (taken.has(format(out)) && guard++ < 3600) {
    out.setUTCSeconds(out.getUTCSeconds() + 1);
  }
  return out;
}

// Build and prepend one alert. Returns the timestamp actually written so the
// caller can log it against the true fill time.
// `file` exists so tests can target a scratch path EXPLICITLY rather than by
// setting an env var, which is load-order dependent and can silently fall back to
// the production feed.
export function prependAlert(
  fields: Omit<CopyAlert, "timestamp" | "timestamp_local">,
  filledAt: Date,
  file: string = alertsFile()
): { written: string; bumpedBy: number } {
  const existing = readAlerts(file);
  const stamp = uniqueTimestamp(filledAt, existing);
  const bumpedBy = Math.round((stamp.getTime() - filledAt.getTime()) / 1000);

  const local = new Date(stamp.getTime() + LOCAL_OFFSET_HOURS * 3600 * 1000);
  const alert: CopyAlert = {
    timestamp: format(stamp),
    timestamp_local: format(local),
    ...fields,
  };

  const next = [alert, ...existing];
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  fs.renameSync(tmp, file);

  return { written: alert.timestamp, bumpedBy };
}
