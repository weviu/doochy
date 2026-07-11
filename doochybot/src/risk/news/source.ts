import { CalendarSource, EconomicEvent } from "./types";

// ForexFactory's free weekly JSON mirror (no key). Each item is:
//   { title, country, date, impact, forecast, previous }
// where `country` is a currency code ("USD","EUR",...), `impact` is one of
// {High,Medium,Low,Holiday}, and `date` is ISO-8601 WITH a UTC offset, e.g.
// "2026-07-10T08:30:00-04:00". The offset already encodes DST, so parsing to
// epoch ms is offset/DST-correct without any hard-coded release times.
const THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEXT_WEEK = "https://nfs.faireconomy.media/ff_calendar_nextweek.json";

interface FFItem {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
}

// UTC YYYY-MM-DD for an epoch-ms instant (used as the all-day block date and as
// part of the dedupe id).
function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// FF stamps all-day / tentative events (FOMC minutes day, some Fed speakers, bank
// holidays) at local midnight (T00:00:00). A real timed release (NFP/CPI 08:30,
// FOMC 14:00) never lands exactly on midnight, so a midnight local time is our
// signal that there is no reliable clock time to run a timed flatten against.
function isMidnightLocal(isoDate: string): boolean {
  return /T00:00:00/.test(isoDate);
}

function normalizeImpact(raw: string): EconomicEvent["impact"] | null {
  switch (raw) {
    case "High":
    case "Medium":
    case "Low":
    case "Holiday":
      return raw;
    default:
      return null;
  }
}

// Convert one raw FF item into our normalized event, or null if it can't be parsed
// (bad date / unknown impact). Kept pure and exported so unit tests can exercise
// the DST/offset parsing directly.
export function parseFFItem(item: FFItem): EconomicEvent | null {
  if (!item || !item.title || !item.country || !item.date) return null;
  const impact = normalizeImpact(item.impact);
  if (!impact) return null;

  const ms = Date.parse(item.date); // resolves the ISO offset -> UTC epoch ms
  if (Number.isNaN(ms)) return null;

  const allDay = isMidnightLocal(item.date);
  const time = allDay ? null : ms;
  // All-day events are anchored to their LOCAL calendar day. A midnight-local
  // stamp converted to UTC can roll into the previous UTC day (e.g. 00:00-04:00
  // is 04:00 UTC same day, fine; but negative-only offsets keep it same-day), so
  // for the date string we take the UTC date of the parsed instant either way -
  // for a timed event that's the release's UTC day, for an all-day event it's the
  // day we block. Good enough: the block is a whole-UTC-day guard.
  const dateStr = utcDateStr(ms);
  const id = `${item.country}|${item.title}|${dateStr}`;

  return { id, title: item.title, currency: item.country, impact, time, dateStr, allDay };
}

async function fetchJson(url: string): Promise<FFItem[]> {
  const res = await fetch(url, {
    // Be a polite, identifiable client. The mirror sits behind Cloudflare and can
    // return an HTML challenge page instead of JSON when hammered - we detect that
    // below and throw so the caller falls back to last-good cache.
    headers: { "User-Agent": "DoochyBot/1.0 news-calendar (+https://github.com/weviu/DoochyBot)" },
    // Bounded so a hung/unreachable host can't stall the boot-time refresh or a
    // scheduled tick. On abort/timeout fetch rejects and the caller keeps cache.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = new Error(`${url} -> HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[")) {
    throw new Error(`${url} -> non-JSON response (likely a Cloudflare challenge)`);
  }
  const data = JSON.parse(trimmed);
  if (!Array.isArray(data)) throw new Error(`${url} -> unexpected shape (not an array)`);
  return data as FFItem[];
}

export class ForexFactorySource implements CalendarSource {
  readonly name = "forexfactory";

  async fetchEvents(): Promise<EconomicEvent[]> {
    // Fetch both weeks. Sequentially (not Promise.all) to stay gentle on the
    // mirror; if only one week succeeds we still return what we got rather than
    // failing the whole refresh.
    const items: FFItem[] = [];
    let anyOk = false;
    for (const url of [THIS_WEEK, NEXT_WEEK]) {
      try {
        items.push(...(await fetchJson(url)));
        anyOk = true;
      } catch (err: any) {
        // A 404 is expected, not an error: the mirror only publishes next week's
        // file later in the week (and occasionally rotates this week's), so log it
        // quietly. Real problems (network, Cloudflare challenge, bad shape) warn.
        if (err?.status === 404) {
          const file = url.slice(url.lastIndexOf("/") + 1);
          console.log(`[news] ${this.name}: ${file} not published yet (404) - skipping`);
        } else {
          console.warn(`[news] ${this.name}: ${err.message}`);
        }
      }
    }
    if (!anyOk) throw new Error("both weekly calendar fetches failed");

    // Normalize, drop unparseable, dedupe revised entries by id (later item wins -
    // a revised forecast keeps the same id, so this collapses duplicates).
    const byId = new Map<string, EconomicEvent>();
    for (const raw of items) {
      const ev = parseFFItem(raw);
      if (ev) byId.set(ev.id, ev);
    }
    const events = [...byId.values()].sort((a, b) => (a.time ?? Date.parse(a.dateStr)) - (b.time ?? Date.parse(b.dateStr)));
    console.log(`[news] ${this.name}: fetched ${items.length} raw, ${events.length} unique events`);
    return events;
  }
}
