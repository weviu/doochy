// A single scheduled economic release, normalized from whatever calendar source
// produced it. All times are UTC epoch ms so window math is offset/DST-free once
// we're past parsing (the source resolves the ISO offset when it builds these).
export interface EconomicEvent {
  // Stable dedupe key: `${currency}|${title}|${dateStr}`. A revised entry (same
  // title/date, changed forecast) collapses onto the same id, so the flatten
  // marker survives a mid-week calendar revision.
  id: string;
  title: string;
  currency: string; // "USD","EUR",... (ForexFactory's `country` field is a currency code)
  impact: "High" | "Medium" | "Low" | "Holiday";
  // Precise release time in UTC epoch ms, or null for an all-day / tentative event
  // that carries no reliable clock time (FOMC minutes day, some Fed speakers).
  time: number | null;
  // Calendar date the event belongs to, YYYY-MM-DD in UTC. Drives the all-day
  // entry block (which has no precise time to run a timed flatten against).
  dateStr: string;
  // True when `time` is null: block entries for the whole `dateStr`, never run the
  // timed flatten (we don't trust a clock time we don't have).
  allDay: boolean;
}

// Tunables for the news guard. Defaults live in config.ts; a data/news-config.json
// can override any field without a code change.
export interface NewsConfig {
  preBlackoutMin: number; // block new in-scope entries this long BEFORE an event
  postBlackoutMin: number; // ...and this long AFTER (window clears at event + this)
  flattenLeadMin: number; // market-close open in-scope positions this long before an event
  currencies: string[]; // event currencies in scope, e.g. ["USD"]
  impactLevels: Array<"High" | "Medium" | "Low" | "Holiday">; // e.g. ["High"]
  symbols: string[]; // instrument symbols the guard applies to, e.g. ["XAUUSD"]
  sources: string[]; // signal_source values in scope, e.g. ["gold_scanner"] ([] = any source)
  maxStaleHours: number; // if the cache is older than this and can't refresh, apply failClosed
  failClosed: boolean; // on stale/empty data, BLOCK new in-scope entries (never force-flatten on stale data)
  includeTentativeAsAllDay: boolean; // treat all-day/tentative in-scope events as a full-day entry block
  refreshHours: number; // how often to refetch the calendar (calendars change rarely; be polite)
}

// Result of an entry-blackout check. `blocked` is all a caller needs; the rest is
// for logging the WHY (the observability requirement).
export interface EntryBlackout {
  blocked: boolean;
  event?: EconomicEvent; // the event whose window we're inside (or the all-day event)
  reason?: string; // human-readable cause, ready to log
  failClosed?: boolean; // true when blocked purely because the calendar is stale (not a real window)
}

// Result of a flatten check for one symbol at one instant.
export interface FlattenDecision {
  flatten: boolean;
  event?: EconomicEvent; // the timed event that triggered it (used to mark idempotency + log)
}

// A calendar source (ForexFactory today; FMP/Finnhub swappable). fetchEvents()
// returns the merged, normalized, deduped event list or throws on failure (the
// caller falls back to last-good cache).
export interface CalendarSource {
  readonly name: string;
  fetchEvents(): Promise<EconomicEvent[]>;
}
