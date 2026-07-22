import assert from "node:assert";
import {
  _resetForTest,
  inEntryBlackout,
  shouldFlatten,
  markFlattened,
  upcomingInScope,
  setNewsConfig,
  DEFAULT_NEWS_CONFIG,
  parseFFItem,
  EconomicEvent,
} from "../src/risk/news";

// Standalone test runner (no test framework configured in this repo). Run with:
//   pnpm test:news   (tsx scripts/news-tests.ts)
// Exits non-zero on the first failed assertion.

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    console.error(`  FAIL - ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
    throw err; // stop at first failure so output stays readable
  }
}

// Pin config to the documented defaults so tests don't depend on any on-disk
// data/news-config.json. failClosed is turned OFF for the window-math/scope/DST/
// all-day sections so those test PURE window logic; the failClosed section below
// turns it back on to test staleness explicitly. (Window tests query a future T
// with a real-now fetchedAt, which would otherwise read as "stale".)
setNewsConfig({ ...DEFAULT_NEWS_CONFIG, failClosed: false });
const MIN = 60_000;

// A USD/High timed event. Time chosen below per-test.
function timedEvent(timeMs: number): EconomicEvent {
  return {
    id: `USD|CPI|${new Date(timeMs).toISOString().slice(0, 10)}`,
    title: "CPI m/m",
    currency: "USD",
    impact: "High",
    time: timeMs,
    dateStr: new Date(timeMs).toISOString().slice(0, 10),
    allDay: false,
  };
}

console.log("Window math (event at T, pre=60 post=15 lead=30):");

// Event at a fixed instant T.
const T = Date.parse("2026-07-10T12:30:00Z");

test("entry blocked exactly at T-60 (pre edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T - 60 * MIN, "XAUUSD", "gold_scanner").blocked, true);
});

test("entry allowed at T-61 (just before pre edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T - 61 * MIN, "XAUUSD", "gold_scanner").blocked, false);
});

test("entry blocked at T (event instant)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T, "XAUUSD", "gold_scanner").blocked, true);
});

test("entry blocked exactly at T+15 (post edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T + 15 * MIN, "XAUUSD", "gold_scanner").blocked, true);
});

test("entry clears at T+16 (just after post edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T + 16 * MIN, "XAUUSD", "gold_scanner").blocked, false);
});

test("flatten fires exactly at T-30 (lead edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(shouldFlatten(T - 30 * MIN, "XAUUSD").flatten, true);
});

test("flatten does NOT fire at T-31 (just before lead edge)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(shouldFlatten(T - 31 * MIN, "XAUUSD").flatten, false);
});

test("flatten still true through T+15, clears at T+16", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(shouldFlatten(T + 15 * MIN, "XAUUSD").flatten, true);
  assert.strictEqual(shouldFlatten(T + 16 * MIN, "XAUUSD").flatten, false);
});

console.log("Scope:");

test("out-of-scope symbol never blocked", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T, "BTCUSD", "gold_scanner").blocked, false);
});

test("out-of-scope source never blocked (channel/manual)", () => {
  _resetForTest([timedEvent(T)], Date.now());
  assert.strictEqual(inEntryBlackout(T, "XAUUSD", "channel").blocked, false);
  assert.strictEqual(inEntryBlackout(T, "XAUUSD", undefined).blocked, false);
});

test("non-USD / non-High event ignored", () => {
  const eur: EconomicEvent = { ...timedEvent(T), id: "EUR|x|d", currency: "EUR" };
  const med: EconomicEvent = { ...timedEvent(T), id: "USD|y|d", impact: "Medium" };
  _resetForTest([eur, med], Date.now());
  assert.strictEqual(inEntryBlackout(T, "XAUUSD", "gold_scanner").blocked, false);
});

console.log("DST boundary (US spring-forward 2026-03-08, EST->EDT):");

// 08:30 America/New_York on 2026-03-06 is EST (-05:00); on 2026-03-09 it is EDT
// (-04:00). Relying on the ISO offset must place both correctly in UTC, so a
// hard-coded "08:30 = 13:30 UTC" assumption would be wrong for one of them.
test("EST release (-05:00) parsed to 13:30 UTC", () => {
  const ev = parseFFItem({ title: "NFP", country: "USD", date: "2026-03-06T08:30:00-05:00", impact: "High" });
  assert.ok(ev);
  assert.strictEqual(new Date(ev!.time!).toISOString(), "2026-03-06T13:30:00.000Z");
});

test("EDT release (-04:00) parsed to 12:30 UTC", () => {
  const ev = parseFFItem({ title: "NFP", country: "USD", date: "2026-03-09T08:30:00-04:00", impact: "High" });
  assert.ok(ev);
  assert.strictEqual(new Date(ev!.time!).toISOString(), "2026-03-09T12:30:00.000Z");
});

test("blackout window correct across the DST-boundary event (EDT)", () => {
  const ev = parseFFItem({ title: "NFP", country: "USD", date: "2026-03-09T08:30:00-04:00", impact: "High" })!;
  _resetForTest([ev], Date.now());
  const t = ev.time!;
  assert.strictEqual(inEntryBlackout(t - 60 * MIN, "XAUUSD", "gold_scanner").blocked, true, "T-60 blocked");
  assert.strictEqual(inEntryBlackout(t - 61 * MIN, "XAUUSD", "gold_scanner").blocked, false, "T-61 clear");
  assert.strictEqual(inEntryBlackout(t + 16 * MIN, "XAUUSD", "gold_scanner").blocked, false, "T+16 clear");
  assert.strictEqual(shouldFlatten(t - 30 * MIN, "XAUUSD").flatten, true, "flatten at T-30");
});

console.log("All-day / tentative:");

test("all-day High event: entry blocked all day, no timed flatten", () => {
  const allDay: EconomicEvent = {
    id: "USD|FOMC Minutes|2026-07-10",
    title: "FOMC Meeting Minutes",
    currency: "USD",
    impact: "High",
    time: null,
    dateStr: "2026-07-10",
    allDay: true,
  };
  _resetForTest([allDay], Date.now());
  const midday = Date.parse("2026-07-10T09:00:00Z");
  assert.strictEqual(inEntryBlackout(midday, "XAUUSD", "gold_scanner").blocked, true, "blocked during the day");
  assert.strictEqual(shouldFlatten(midday, "XAUUSD").flatten, false, "no timed flatten for all-day");
  const nextDay = Date.parse("2026-07-11T09:00:00Z");
  assert.strictEqual(inEntryBlackout(nextDay, "XAUUSD", "gold_scanner").blocked, false, "clear next day");
});

test("midnight-stamped FF item -> all-day", () => {
  const ev = parseFFItem({ title: "Bank Holiday-ish", country: "USD", date: "2026-07-10T00:00:00-04:00", impact: "High" });
  assert.ok(ev);
  assert.strictEqual(ev!.allDay, true);
  assert.strictEqual(ev!.time, null);
});

console.log("failClosed (stale calendar):");

test("stale + failClosed blocks in-scope entries, flagged", () => {
  setNewsConfig({ ...DEFAULT_NEWS_CONFIG, failClosed: true, maxStaleHours: 12 });
  // fetchedAt 13h ago -> stale
  _resetForTest([timedEvent(T)], Date.now() - 13 * 3600_000);
  const res = inEntryBlackout(Date.now(), "XAUUSD", "gold_scanner");
  assert.strictEqual(res.blocked, true);
  assert.strictEqual(res.failClosed, true);
});

test("stale + failClosed does NOT block out-of-scope symbol", () => {
  _resetForTest([timedEvent(T)], Date.now() - 13 * 3600_000);
  assert.strictEqual(inEntryBlackout(Date.now(), "BTCUSD", "gold_scanner").blocked, false);
});

test("stale but failClosed=false does not block on staleness alone", () => {
  setNewsConfig({ ...DEFAULT_NEWS_CONFIG, failClosed: false, maxStaleHours: 12 });
  _resetForTest([timedEvent(T)], Date.now() - 13 * 3600_000);
  // now far from any event window -> not blocked
  assert.strictEqual(inEntryBlackout(Date.now(), "XAUUSD", "gold_scanner").blocked, false);
  setNewsConfig({ ...DEFAULT_NEWS_CONFIG });
});

console.log("Idempotent flatten simulation:");

test("flatten fires once; a second tick does not re-issue it", () => {
  setNewsConfig({ ...DEFAULT_NEWS_CONFIG });
  _resetForTest([timedEvent(T)], Date.now());
  const now1 = T - 28 * MIN; // inside flatten window
  const d1 = shouldFlatten(now1, "XAUUSD");
  assert.strictEqual(d1.flatten, true);
  // Monitor marks the event after acting.
  markFlattened(d1.event!.id, now1);
  // Next tick, still inside the window:
  const d2 = shouldFlatten(now1 + MIN, "XAUUSD");
  assert.strictEqual(d2.flatten, false, "must not re-issue after marking");
});

test("re-opened position after event not flattened again by same event", () => {
  // marker persists from the previous test's event id (same T) -> still suppressed
  _resetForTest([timedEvent(T)], Date.now());
  markFlattened(timedEvent(T).id, T - 28 * MIN);
  assert.strictEqual(shouldFlatten(T - 5 * MIN, "XAUUSD").flatten, false);
});

console.log("upcomingInScope:");

test("upcomingInScope returns future in-scope events sorted, drops past", () => {
  setNewsConfig({ ...DEFAULT_NEWS_CONFIG });
  const past = timedEvent(T - 2 * 3600_000);
  const soon = timedEvent(T + 1 * 3600_000);
  soon.id = "USD|soon|x";
  const later = timedEvent(T + 5 * 3600_000);
  later.id = "USD|later|x";
  _resetForTest([later, soon, past], Date.now());
  const up = upcomingInScope(T);
  assert.strictEqual(up.length, 2, "past dropped");
  assert.strictEqual(up[0].id, "USD|soon|x", "sorted ascending");
  assert.strictEqual(up[1].id, "USD|later|x");
});

console.log(`\n${passed} assertions passed.`);
