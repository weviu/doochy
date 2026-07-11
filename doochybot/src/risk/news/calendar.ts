import fs from "fs";
import path from "path";
import { CalendarSource, EconomicEvent, EntryBlackout, FlattenDecision, NewsConfig } from "./types";
import { ForexFactorySource } from "./source";
import { getNewsConfig } from "./config";

const MIN_MS = 60_000;
const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "news-cache.json");
const FLATTEN_FILE = path.join(DATA_DIR, "news-flatten.json");

interface CacheShape {
  fetchedAt: number; // epoch ms of the last successful fetch
  events: EconomicEvent[];
}

// In-memory calendar state. Seeded from disk on first use so a restart doesn't
// start blind (and doesn't trip failClosed until the cache genuinely ages out).
let cache: CacheShape = { fetchedAt: 0, events: [] };
let loadedFromDisk = false;

// eventId -> epoch ms it was flattened. Persisted so a restart doesn't re-flatten
// an event we already handled, and so a position re-opened after the event isn't
// flattened again by the SAME event. Keyed by the event's dedupe id.
let flattenMarkers: Record<string, number> = {};

// The active source. Swappable (FMP/Finnhub) via setSource for testing or a future
// provider change; defaults to ForexFactory.
let source: CalendarSource = new ForexFactorySource();
export function setSource(s: CalendarSource): void {
  source = s;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCacheFromDisk(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (raw && Array.isArray(raw.events)) {
        cache = { fetchedAt: Number(raw.fetchedAt) || 0, events: raw.events };
        console.log(`[news] loaded ${cache.events.length} cached events (fetched ${cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : "never"})`);
      }
    }
  } catch (err: any) {
    console.warn(`[news] could not read cache: ${err.message}`);
  }
  try {
    if (fs.existsSync(FLATTEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FLATTEN_FILE, "utf-8"));
      if (raw && typeof raw === "object") flattenMarkers = raw;
    }
  } catch (err: any) {
    console.warn(`[news] could not read flatten markers: ${err.message}`);
  }
}

function persistCache(): void {
  try {
    ensureDataDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch (err: any) {
    console.warn(`[news] could not write cache: ${err.message}`);
  }
}

function persistFlattenMarkers(): void {
  try {
    ensureDataDir();
    fs.writeFileSync(FLATTEN_FILE, JSON.stringify(flattenMarkers), "utf-8");
  } catch (err: any) {
    console.warn(`[news] could not write flatten markers: ${err.message}`);
  }
}

export interface RefreshResult {
  ok: boolean;
  count: number;
  fetchedAt: number;
  error?: string;
}

// Refetch from the source and replace the cache on success. On failure, keep the
// last-good cache (callers apply failClosed based on its age). Prunes flatten
// markers older than 7 days so the file doesn't grow forever.
export async function refresh(): Promise<RefreshResult> {
  loadCacheFromDisk();
  try {
    const events = await source.fetchEvents();
    cache = { fetchedAt: Date.now(), events };
    persistCache();
    pruneFlattenMarkers();
    return { ok: true, count: events.length, fetchedAt: cache.fetchedAt };
  } catch (err: any) {
    console.warn(`[news] refresh failed, keeping ${cache.events.length} cached events: ${err.message}`);
    return { ok: false, count: cache.events.length, fetchedAt: cache.fetchedAt, error: err.message };
  }
}

function pruneFlattenMarkers(): void {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  let changed = false;
  for (const [id, ts] of Object.entries(flattenMarkers)) {
    if (ts < cutoff) {
      delete flattenMarkers[id];
      changed = true;
    }
  }
  if (changed) persistFlattenMarkers();
}

// Is the cache too old to trust (older than maxStaleHours)? Empty cache counts as
// stale. Drives the failClosed entry block.
export function isStale(now: number, cfg: NewsConfig = getNewsConfig()): boolean {
  loadCacheFromDisk();
  if (cache.events.length === 0) return true;
  if (!cache.fetchedAt) return true;
  return now - cache.fetchedAt > cfg.maxStaleHours * 3600_000;
}

export function cacheStatus(): { fetchedAt: number; count: number } {
  loadCacheFromDisk();
  return { fetchedAt: cache.fetchedAt, count: cache.events.length };
}

// An event is "in scope" by its own attributes (currency + impact). Symbol/source
// scope is applied separately at the call site (a signal's symbol/source, or an
// open position's symbol).
function eventInScope(ev: EconomicEvent, cfg: NewsConfig): boolean {
  return cfg.currencies.includes(ev.currency) && cfg.impactLevels.includes(ev.impact);
}

export function symbolInScope(symbol: string, cfg: NewsConfig = getNewsConfig()): boolean {
  return cfg.symbols.includes(symbol);
}

// Entry scope: symbol must be in scope AND (no source filter, or the signal's
// source is listed). A signal with no source is out of scope when a source filter
// is set - matches "feed entries where signal_source == gold_scanner".
export function entryInScope(symbol: string, source: string | undefined, cfg: NewsConfig = getNewsConfig()): boolean {
  if (!symbolInScope(symbol, cfg)) return false;
  if (cfg.sources.length === 0) return true;
  return source != null && cfg.sources.includes(source);
}

// All in-scope events at/after `now`, timed ones by time and today's/future all-day
// ones by date, sorted ascending. Timed events already past `now` are dropped;
// all-day events are kept while their UTC date is today or later.
export function upcomingInScope(now: number, cfg: NewsConfig = getNewsConfig()): EconomicEvent[] {
  loadCacheFromDisk();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  return cache.events
    .filter((ev) => eventInScope(ev, cfg))
    .filter((ev) => (ev.time != null ? ev.time >= now : ev.dateStr >= todayStr))
    .sort((a, b) => (a.time ?? Date.parse(a.dateStr)) - (b.time ?? Date.parse(b.dateStr)));
}

function utcHm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

// Entry blackout: block a new in-scope entry if `now` is within
// [event - preBlackoutMin, event + postBlackoutMin] of any in-scope TIMED event,
// or on the date of an in-scope ALL-DAY event (when includeTentativeAsAllDay).
// Also fail-closed: if the calendar is stale and failClosed is on, block. Symbol/
// source scope is the caller's responsibility (pass an in-scope symbol/source).
export function inEntryBlackout(
  now: number,
  symbol: string,
  signalSource?: string,
  cfg: NewsConfig = getNewsConfig()
): EntryBlackout {
  if (!entryInScope(symbol, signalSource, cfg)) return { blocked: false };
  loadCacheFromDisk();

  // Fail-closed on untrusted data (empty/stale cache). Safe on a prop account:
  // block NEW entries. (The flatten path deliberately does NOT act on stale data.)
  if (cfg.failClosed && isStale(now, cfg)) {
    return {
      blocked: true,
      failClosed: true,
      reason: `calendar stale (>${cfg.maxStaleHours}h) - failClosed blocks new ${symbol} entries`,
    };
  }

  const todayStr = new Date(now).toISOString().slice(0, 10);
  for (const ev of cache.events) {
    if (!eventInScope(ev, cfg)) continue;

    if (ev.allDay) {
      if (cfg.includeTentativeAsAllDay && ev.dateStr === todayStr) {
        return { blocked: true, event: ev, reason: `${ev.title} (${ev.currency}/${ev.impact}) all-day ${ev.dateStr} - entry blocked` };
      }
      continue;
    }

    const start = ev.time! - cfg.preBlackoutMin * MIN_MS;
    const end = ev.time! + cfg.postBlackoutMin * MIN_MS;
    if (now >= start && now <= end) {
      return {
        blocked: true,
        event: ev,
        reason: `${ev.title} (${ev.currency}/${ev.impact}) at ${utcHm(ev.time!)} UTC, in blackout`,
      };
    }
  }
  return { blocked: false };
}

// Flatten decision for one symbol at one instant: fire if an in-scope TIMED event
// is within its flatten window [event - flattenLeadMin, event + postBlackoutMin]
// AND it hasn't already been flattened. All-day events never trigger a timed
// flatten (no reliable time). Returns the triggering event so the caller can mark
// it and log which event caused the close.
export function shouldFlatten(
  now: number,
  symbol: string,
  cfg: NewsConfig = getNewsConfig()
): FlattenDecision {
  if (!symbolInScope(symbol, cfg)) return { flatten: false };
  loadCacheFromDisk();

  for (const ev of cache.events) {
    if (!eventInScope(ev, cfg) || ev.allDay || ev.time == null) continue;
    if (flattenMarkers[ev.id]) continue; // already handled this event
    const start = ev.time - cfg.flattenLeadMin * MIN_MS;
    const end = ev.time + cfg.postBlackoutMin * MIN_MS;
    if (now >= start && now <= end) {
      return { flatten: true, event: ev };
    }
  }
  return { flatten: false };
}

// Idempotency: record that an event's flatten has been issued so no later tick
// re-issues it (and a position re-opened after the event isn't flattened again by
// the same event). Persisted to disk.
export function markFlattened(eventId: string, now: number = Date.now()): void {
  flattenMarkers[eventId] = now;
  persistFlattenMarkers();
}

export function isFlattened(eventId: string): boolean {
  return !!flattenMarkers[eventId];
}

// Test-only reset of in-memory state (cache + markers + disk-load latch), so unit
// tests can inject a known calendar deterministically.
export function _resetForTest(events: EconomicEvent[], fetchedAt: number): void {
  cache = { fetchedAt, events };
  flattenMarkers = {};
  loadedFromDisk = true;
}
