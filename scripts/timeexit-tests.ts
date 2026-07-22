import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { state } from "../src/state";
import { setMidnightConnection } from "../src/risk/midnightClose";
import {
  effectiveTimeExitMin,
  restingExpiryMs,
  recordTimedPosition,
  clearTimedPosition,
  restoreTimedPositions,
  timerFor,
  setTimeExitConfig,
  DEFAULT_TIME_EXIT_CONFIG,
  _resetForTest,
  _tickForTest,
} from "../src/risk/timeExit";

// Standalone runner (no test framework). Run: pnpm test:timeexit
// Exits non-zero on the first failed assertion.

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    console.error(`  FAIL - ${name}\n        ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

setTimeExitConfig({ ...DEFAULT_TIME_EXIT_CONFIG });
const MIN = 60_000;

// A fake broker connection whose close either succeeds or fails (to simulate a
// closed market). closePosition() deletes the position + clears the timer on success.
function connCloses(ok: boolean) {
  return {
    sendCommand: async (name: string) => {
      if (name === "ProtoOAClosePositionReq" && !ok) throw new Error("MARKET_CLOSED");
      return {};
    },
  };
}

function openPosition(id: number, symbol: string, fillTime: number, timeExitMin: number | null) {
  state.positions.set(id, {
    symbol,
    direction: "BUY",
    volume: 0.1,
    volumeCents: 10,
    entryPrice: 4000,
    openTime: fillTime,
    timeExitMin,
  });
}

async function main() {
  console.log("effectiveTimeExitMin (scope + clamp + backward-compat):");

  await test("in-scope XAUUSD/gold_scanner 480 -> 480", () => {
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", 480), 480);
  });
  await test("clamps to maxTimeExitMin (1440)", () => {
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", 99999), 1440);
  });
  await test("out-of-scope symbol -> 0", () => {
    assert.strictEqual(effectiveTimeExitMin("BTCUSD", "gold_scanner", 480), 0);
  });
  await test("out-of-scope source -> 0", () => {
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "channel", 480), 0);
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", undefined, 480), 0);
  });
  await test("backward-compat: null/undefined/0/negative -> 0", () => {
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", null), 0);
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", undefined), 0);
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", 0), 0);
    assert.strictEqual(effectiveTimeExitMin("XAUUSD", "gold_scanner", -5), 0);
  });

  console.log("Pending-order (resting) expiry folding:");

  await test("time exit caps a longer stale window", () => {
    // stale 600m, timeExit 480m -> 480m
    assert.strictEqual(restingExpiryMs(600 * MIN, 480), 480 * MIN);
  });
  await test("shorter stale window wins over time exit", () => {
    assert.strictEqual(restingExpiryMs(120 * MIN, 480), 120 * MIN);
  });
  await test("no stale window -> time exit window", () => {
    assert.strictEqual(restingExpiryMs(0, 480), 480 * MIN);
  });
  await test("no time exit -> stale window unchanged (0 stays GTC)", () => {
    assert.strictEqual(restingExpiryMs(0, 0), 0);
    assert.strictEqual(restingExpiryMs(90 * MIN, 0), 90 * MIN);
  });

  console.log("Monitor - timer fires at expiry:");

  await test("fill at T with 480m, no SL/TP hit -> closes at market at T+480", async () => {
    setMidnightConnection(connCloses(true));
    const now = Date.now();
    _resetForTest({ "1": { symbol: "XAUUSD", timeExitMin: 480, fillTime: now - 481 * MIN } });
    openPosition(1, "XAUUSD", now - 481 * MIN, 480);
    await _tickForTest();
    assert.strictEqual(state.positions.has(1), false, "position closed");
    assert.strictEqual(timerFor(1), undefined, "timer cleared");
  });

  await test("SL-first: before T+480 the timer never closes (position stays open)", async () => {
    setMidnightConnection(connCloses(true));
    const now = Date.now();
    _resetForTest({ "2": { symbol: "XAUUSD", timeExitMin: 480, fillTime: now - 100 * MIN } });
    openPosition(2, "XAUUSD", now - 100 * MIN, 480);
    await _tickForTest();
    assert.strictEqual(state.positions.has(2), true, "still open (timer not reached)");
    assert.ok(timerFor(2), "timer still armed");
    // Now simulate the SL close arriving (broker CLOSED handler removes + clears):
    state.positions.delete(2);
    clearTimedPosition(2);
    // Advance past expiry: nothing to close, no error.
    _resetForTest({ "2": { symbol: "XAUUSD", timeExitMin: 480, fillTime: now - 481 * MIN } });
    await _tickForTest();
    assert.strictEqual(state.positions.has(2), false);
  });

  console.log("Monitor - market-closed reopen:");

  await test("expiry during closed market: retry, then close at reopen", async () => {
    const now = Date.now();
    _resetForTest({ "3": { symbol: "XAUUSD", timeExitMin: 480, fillTime: now - 481 * MIN } });
    openPosition(3, "XAUUSD", now - 481 * MIN, 480);
    // Market closed: close fails, timer must persist (not silently held/forgotten).
    setMidnightConnection(connCloses(false));
    await _tickForTest();
    assert.strictEqual(state.positions.has(3), true, "still open after failed close");
    assert.ok(timerFor(3), "timer retained for retry");
    // Market reopens: next tick closes it.
    setMidnightConnection(connCloses(true));
    await _tickForTest();
    assert.strictEqual(state.positions.has(3), false, "closed at reopen");
    assert.strictEqual(timerFor(3), undefined);
  });

  console.log("Backward-compat: non-timed positions untouched:");

  await test("position with no timer is never closed by the monitor", async () => {
    setMidnightConnection(connCloses(true));
    _resetForTest({}); // no timers at all
    openPosition(4, "XAUUSD", Date.now() - 10000 * MIN, null);
    await _tickForTest();
    assert.strictEqual(state.positions.has(4), true, "untouched (no timer recorded)");
    state.positions.delete(4);
  });

  console.log("Restart recovery:");

  await test("recordTimedPosition persists to disk", () => {
    _resetForTest({});
    const fillTime = Date.now() - 60 * MIN;
    recordTimedPosition(5, "XAUUSD", 480, fillTime);
    const file = path.join(process.cwd(), "data", "time-exits.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.ok(onDisk["5"], "entry written to disk");
    assert.strictEqual(onDisk["5"].timeExitMin, 480);
    assert.strictEqual(onDisk["5"].fillTime, fillTime);
  });

  await test("restore re-attaches timeExitMin to a reconciled position", () => {
    const fillTime = Date.now() - 60 * MIN;
    _resetForTest({ "6": { symbol: "XAUUSD", timeExitMin: 480, fillTime } });
    // Simulate reconcile giving us the position back WITHOUT our metadata:
    openPosition(6, "XAUUSD", 0, null);
    delete state.positions.get(6)!.timeExitMin;
    restoreTimedPositions();
    assert.strictEqual(state.positions.get(6)!.timeExitMin, 480, "timer re-attached");
    assert.strictEqual(state.positions.get(6)!.openTime, fillTime, "fill time aligned");
    state.positions.delete(6);
  });

  await test("restore does NOT prune a recent timer whose position is missing (failed reconcile)", () => {
    const fillTime = Date.now() - 60 * MIN;
    _resetForTest({ "7": { symbol: "XAUUSD", timeExitMin: 480, fillTime } });
    // No position 7 in state (reconcile returned nothing) -> must keep the timer.
    restoreTimedPositions();
    assert.ok(timerFor(7), "recent orphan retained (would-hold-past-window bug avoided)");
  });

  await test("restore prunes an ancient orphan (safety valve)", () => {
    const fillTime = Date.now() - (480 + 1440 + 10) * MIN; // well past expiry + grace
    _resetForTest({ "8": { symbol: "XAUUSD", timeExitMin: 480, fillTime } });
    restoreTimedPositions();
    assert.strictEqual(timerFor(8), undefined, "ancient orphan pruned");
  });

  console.log(`\n${passed} assertions passed.`);
}

// Snapshot and restore the on-disk store so the test doesn't clobber real runtime state.
const STORE = path.join(process.cwd(), "data", "time-exits.json");
const backup = fs.existsSync(STORE) ? fs.readFileSync(STORE, "utf-8") : null;

main()
  .catch(() => { /* assertion already logged; exit code set */ })
  .finally(() => {
    if (backup !== null) fs.writeFileSync(STORE, backup, "utf-8");
    else if (fs.existsSync(STORE)) fs.rmSync(STORE);
    // Timers from setInterval in other modules aren't started here, so the process
    // exits on its own; force it in case a stray handle lingers.
    process.exit(process.exitCode ?? 0);
  });
