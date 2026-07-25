import assert from "node:assert";
import { decideLimits, LimitInputs } from "../src/risk/limits";
import { dayKey, dayStartMs, inPreResetWindow } from "../src/risk/tradingDay";
import { fetchRealizedPnLSince } from "../src/ctrader/account";

// Standalone test runner for the daily risk engine's pure parts (no test
// framework configured in this repo). Run with:
//   pnpm test:risk   (tsx scripts/risk-tests.ts)
// Exits non-zero on the first failed assertion.

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  const done = () => {
    passed++;
    console.log(`  ok  - ${name}`);
  };
  const fail = (err: any) => {
    console.error(`  FAIL - ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
    throw err; // stop at first failure so output stays readable
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(done, fail);
    done();
  } catch (err: any) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
console.log("decideLimits");

const base: LimitInputs = {
  seeded: true,
  override: false,
  realized: 0,
  floating: 0,
  complete: true,
  maxLossUSD: 200,
  capUSD: 0,
  capBufferUSD: 0,
};

test("all flat -> OK", () => {
  assert.equal(decideLimits(base).kind, "OK");
});

test("unseeded wins over everything", () => {
  const v = decideLimits({ ...base, seeded: false, realized: -9999 });
  assert.equal(v.kind, "UNSEEDED");
});

test("loss breach at exactly -limit (<=, not <)", () => {
  const v = decideLimits({ ...base, realized: -200 });
  assert.equal(v.kind, "LOSS_BREACH");
});

test("no breach one cent inside the limit", () => {
  assert.equal(decideLimits({ ...base, realized: -199.99 }).kind, "OK");
});

test("realized + floating combine for the loss limit", () => {
  const v = decideLimits({ ...base, realized: -150, floating: -60 });
  assert.equal(v.kind, "LOSS_BREACH");
});

test("maxLossUSD 0 means DISABLED, not 'any loss'", () => {
  assert.equal(decideLimits({ ...base, maxLossUSD: 0, realized: -5000 }).kind, "OK");
});

test("override suppresses a clear breach", () => {
  const v = decideLimits({ ...base, override: true, realized: -5000 });
  assert.equal(v.kind, "OVERRIDDEN");
});

test("cap breach at trigger = cap - buffer", () => {
  const v = decideLimits({ ...base, capUSD: 400, capBufferUSD: 10, realized: 300, floating: 90 });
  assert.equal(v.kind, "CAP_BREACH");
  assert.equal((v as any).trigger, 390);
});

test("cap not hit below trigger", () => {
  assert.equal(decideLimits({ ...base, capUSD: 400, capBufferUSD: 10, realized: 389 }).kind, "OK");
});

test("cap 0 = disabled", () => {
  assert.equal(decideLimits({ ...base, capUSD: 0, realized: 100000 }).kind, "OK");
});

test("incomplete floating: winner's untracked gain can't hide a realized loss breach", () => {
  // floating +500 would mask the -250 realized, but that floating is incomplete.
  const v = decideLimits({ ...base, realized: -250, floating: 500, complete: false });
  assert.equal(v.kind, "INCOMPLETE");
  assert.equal((v as any).realizedOnly.kind, "LOSS_BREACH");
});

test("incomplete floating: no lock when realized alone is fine", () => {
  const v = decideLimits({ ...base, realized: -50, floating: -500, complete: false });
  assert.equal(v.kind, "INCOMPLETE");
  assert.equal((v as any).realizedOnly.kind, "OK");
});

// ---------------------------------------------------------------------------
console.log("tradingDay (Europe/Berlin broker clock)");

const TZ = "Europe/Berlin";
const T = (iso: string) => Date.parse(iso);

test("dayKey: plain afternoon matches the UTC date", () => {
  assert.equal(dayKey(T("2026-01-15T12:00:00Z"), TZ), "2026-01-15");
});

test("dayKey: winter evening 23:30 UTC is already the NEXT broker day (CET=UTC+1)", () => {
  assert.equal(dayKey(T("2026-01-15T23:30:00Z"), TZ), "2026-01-16");
});

test("dayKey: summer evening 22:30 UTC is the next broker day (CEST=UTC+2)", () => {
  assert.equal(dayKey(T("2026-07-15T22:30:00Z"), TZ), "2026-07-16");
});

test("dayKey: summer 21:30 UTC is still the same broker day", () => {
  assert.equal(dayKey(T("2026-07-15T21:30:00Z"), TZ), "2026-07-15");
});

test("dayStartMs: winter day starts at 23:00 UTC the previous evening", () => {
  assert.equal(dayStartMs(T("2026-01-15T12:00:00Z"), TZ), T("2026-01-14T23:00:00Z"));
});

test("dayStartMs: summer day starts at 22:00 UTC the previous evening", () => {
  assert.equal(dayStartMs(T("2026-07-15T12:00:00Z"), TZ), T("2026-07-14T22:00:00Z"));
});

test("dayStartMs: spring-forward day (29 Mar 2026) still starts at its CET midnight", () => {
  // Midnight is CET (+1) — the jump to CEST happens at 02:00 local.
  assert.equal(dayStartMs(T("2026-03-29T12:00:00Z"), TZ), T("2026-03-28T23:00:00Z"));
});

test("dayStartMs: fall-back day (25 Oct 2026) starts at its CEST midnight", () => {
  assert.equal(dayStartMs(T("2026-10-25T12:00:00Z"), TZ), T("2026-10-24T22:00:00Z"));
});

test("dayStartMs is idempotent at the boundary itself", () => {
  const start = dayStartMs(T("2026-07-15T12:00:00Z"), TZ);
  assert.equal(dayStartMs(start, TZ), start);
  assert.equal(dayKey(start, TZ), "2026-07-15");
  assert.equal(dayKey(start - 1, TZ), "2026-07-14");
});

test("inPreResetWindow: winter 22:55 UTC = 23:55 CET -> true; 22:54 -> false", () => {
  assert.equal(inPreResetWindow(T("2026-01-15T22:55:00Z"), TZ), true);
  assert.equal(inPreResetWindow(T("2026-01-15T22:54:59Z"), TZ), false);
});

test("inPreResetWindow: summer 21:55 UTC = 23:55 CEST -> true; 22:01 UTC (new day) -> false", () => {
  assert.equal(inPreResetWindow(T("2026-07-15T21:55:00Z"), TZ), true);
  assert.equal(inPreResetWindow(T("2026-07-15T22:01:00Z"), TZ), false);
});

// ---------------------------------------------------------------------------
console.log("fetchRealizedPnLSince (pagination)");

// Fake connection: three pages of deals, hasMore on the first two. Money fields
// are scaled by 10^moneyDigits like the real API. Page boundaries repeat the
// last deal (as timestamp-based paging does) to exercise the dedupe.
function fakeDeal(id: number, ts: number, gross: number | null) {
  return {
    dealId: id,
    executionTimestamp: ts,
    ...(gross === null
      ? {}
      : { closePositionDetail: { grossProfit: gross * 100, swap: 0, commission: -100, moneyDigits: 2 } }),
  };
}

async function run(): Promise<void> {
  const pages = [
    { deal: [fakeDeal(1, 1000, 10), fakeDeal(2, 2000, null), fakeDeal(3, 3000, -20)], hasMore: true },
    { deal: [fakeDeal(3, 3000, -20), fakeDeal(4, 4000, 5)], hasMore: true },
    { deal: [fakeDeal(4, 4000, 5), fakeDeal(5, 5000, -1)], hasMore: false },
  ];
  const calls: any[] = [];
  const conn = {
    sendCommand: async (_name: string, payload: any) => {
      calls.push(payload);
      return pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  };

  await test("pages until hasMore is false, advancing fromTimestamp", async () => {
    const { net, dealIds } = await fetchRealizedPnLSince(conn, 500);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].fromTimestamp, 500);
    assert.equal(calls[1].fromTimestamp, 3000);
    assert.equal(calls[2].fromTimestamp, 4000);
    // Boundary deals counted once; opening deal (no closePositionDetail) adds 0.
    // Nets: 10-1 + (-20-1) + (5-1) + (-1-1) = 9 - 21 + 4 - 2 = -10
    assert.equal(Number(net.toFixed(2)), -10);
    assert.deepEqual([...dealIds].sort(), ["1", "2", "3", "4", "5"]);
  });

  console.log(`\n${passed} tests passed`);
}

run().catch(() => process.exit(1));
