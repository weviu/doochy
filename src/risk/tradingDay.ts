// Broker trading-day model. cTrader prop accounts reset their daily counters at
// midnight in the broker's server timezone (CET/CEST for ours), NOT midnight
// UTC. Every daily-limit concern — seeding today's realized P&L, resetting the
// counter, expiring the daily lock, the pre-reset flatten — must share this one
// definition of "day", otherwise the bot enforces limits against a different
// day than the prop firm judges it on (the old code used UTC midnight and was
// wrong by 1-2 hours every evening).
//
// The timezone is code-level config (env BROKER_DAY_TZ, IANA name), not a bot
// setting: it's a property of the broker, not something to flip at runtime.
// DST is handled by the timezone database via Intl, never by hand.

const BROKER_TZ = process.env.BROKER_DAY_TZ || "Europe/Berlin";

// Flatten this many minutes before the broker's midnight, so nothing is open
// when the prop firm's daily counters roll over.
export const FLATTEN_MINUTES_BEFORE_RESET = 5;

// One formatter per timezone (construction is expensive; the ticker calls this
// every second). h23 avoids the "24:00" hour some environments emit.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface WallClock { y: number; m: number; d: number; hh: number; mm: number; ss: number }

function wallClock(ms: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute"), ss: get("second") };
}

// The broker-day identity of an instant: the calendar date at the broker's
// clock, "YYYY-MM-DD". Two instants are in the same trading day iff their keys
// match; a key CHANGE between ticks is the day rollover.
export function dayKey(ms: number = Date.now(), tz: string = BROKER_TZ): string {
  const w = wallClock(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

// Epoch ms when the broker day containing `ms` began (the broker's local
// midnight). Used as the from-window for seeding realized P&L. Standard
// zoned-midnight resolution: guess the UTC instant, read back what wall time it
// lands on, correct by the difference; a second pass absorbs a DST edge.
export function dayStartMs(ms: number = Date.now(), tz: string = BROKER_TZ): number {
  const w = wallClock(ms, tz);
  const wantedWall = Date.UTC(w.y, w.m - 1, w.d, 0, 0, 0);
  let ts = wantedWall;
  for (let i = 0; i < 2; i++) {
    const got = wallClock(ts, tz);
    const gotWall = Date.UTC(got.y, got.m - 1, got.d, got.hh, got.mm, got.ss);
    ts += wantedWall - gotWall;
  }
  return ts;
}

// True inside the final minutes of the broker day (23:55-00:00 broker time by
// default): the window in which the engine flattens everything and holds
// trading until the new day starts.
export function inPreResetWindow(ms: number = Date.now(), tz: string = BROKER_TZ): boolean {
  const w = wallClock(ms, tz);
  return w.hh === 23 && w.mm >= 60 - FLATTEN_MINUTES_BEFORE_RESET;
}
