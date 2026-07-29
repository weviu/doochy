import { state, setTradingLock, persistRuntime } from "../state";
import { notify } from "../bot/notify";
import { getMarkPrice, quoteToUsd, hasLiveQuote, subscribeOpenPositions } from "../ctrader/livePrices";
import { fetchRealizedPnLSince } from "../ctrader/account";
import { closeAllPositions } from "./midnightClose";
import { cancelAllRestingEntryOrders } from "../ctrader/orders";
import { decideLimits, LimitVerdict } from "./limits";
import { dayKey, dayStartMs, inPreResetWindow, FLATTEN_MINUTES_BEFORE_RESET } from "./tradingDay";

// The daily risk engine — the ONE owner of the daily loss limit and profit cap.
// It replaces the old dailyLoss.ts (lock-only checks) + lossMonitor.ts +
// capMonitor.ts trio, which each carried their own copy of the P&L math and the
// data-completeness guards and had quietly diverged.
//
// Responsibilities, all on one 1s ticker plus event hooks:
//  - keep today's realized P&L correct: broker-seeded at boot/reconnect
//    (paginated, deal-ids remembered so a late close event can't double-count),
//    then updated per closing deal;
//  - evaluate realized + floating against the loss limit and profit cap via the
//    pure decideLimits(), and on a confirmed breach lock trading, close every
//    position AND cancel every resting entry order;
//  - run the broker-day schedule: flatten in the final minutes before the
//    broker's midnight, and reset P&L/lock/override when the day key changes
//    (drift-proof — no exact-minute matching);
//  - fail CLOSED: if the P&L seed cannot be read, trading is locked and the
//    seed retries until it succeeds, instead of running the day with limits
//    silently disabled.

const POLL_MS = 1_000;
// A single breaching tick can be a wick or a spread blip. Require the breach to
// persist across consecutive polls before force-closing.
const CONFIRM_TICKS = 2;
const SEED_RETRY_MS = 30_000;

// Lock reasons. Short stable labels: /status and the app display them, and the
// seed path uses REASON_SEED to recognise (and clear) its own lock without
// touching a genuine daily-limit lock.
export const REASON_LOSS = "Daily loss limit reached";
export const REASON_CAP = "Daily profit cap reached";
export const REASON_SEED = "Daily P&L not confirmed with broker";
export const REASON_ROLLOVER = "Broker day rollover";

let connection: any = null;

// Closing deals already applied to the realized counter — by a live close event
// OR by a broker seed whose window included them. One set, so the seed/event
// races that double-counted before are structurally impossible. Cleared at the
// day rollover (when the counter it guards resets to 0).
const countedDeals = new Set<string>();

// Seed/event race: a close landing while a seed fetch is in flight may or may
// not be inside the fetched window. Buffer those events; when the seed result
// replaces the counter, re-apply only the ones the fetch did NOT include.
let seedInFlight = false;
let seedBuffer: { dealId: string; net: number }[] = [];

let lossStreak = 0;
let capStreak = 0;
let closing = false; // a force-close sweep is in flight; don't start another
let currentDay = dayKey();
let flattenedDay: string | null = null; // pre-reset flatten already ran for this day key
let seedTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Floating P&L

// Unrealized P&L (USD) across ALL open positions — deliberately not filtered by
// allowedSymbols: a losing position on a de-listed symbol is still real money
// against the daily limit (the old code silently excluded them). `complete` is
// false when any position lacks a live quote or a USD conversion rate; the sum
// then omits it and callers must not force-close on the partial figure.
//
// Booked costs (entry-side commission, accrued swap — stored SIGNED on the
// position, in account currency) are included: the daily limits are judged on
// NET realized P&L, so enforcing them on a gross floating figure understates
// every loss by the costs. The exit-side commission (charged on close) is the
// remaining, accepted approximation.
export function floatingPnL(): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const pos of state.positions.values()) {
    const factor = quoteToUsd(pos.symbol);
    const mark = hasLiveQuote(pos.symbol) ? getMarkPrice(pos.symbol, pos.direction) : null;
    if (factor === null || !mark || !pos.entryPrice) {
      complete = false;
      continue;
    }
    const diff = pos.direction === "BUY" ? mark - pos.entryPrice : pos.entryPrice - mark;
    usd += diff * (pos.volumeCents / 100) * factor + (pos.commission ?? 0) + (pos.swap ?? 0);
  }
  return { usd, complete };
}

// Plain-number convenience for display/equity callers that just want the sum.
export function floatingPnLUsd(): number {
  return floatingPnL().usd;
}

export function maxLossUSD(): number {
  return state.settings.maxDailyLossUSD;
}

export function isLocked(): boolean {
  return state.tradingLocked;
}

// ---------------------------------------------------------------------------
// Evaluation (lock-only path — the gate and close events call this; the ticker
// below additionally force-closes)

function currentVerdict(): LimitVerdict {
  const { usd, complete } = floatingPnL();
  return decideLimits({
    seeded: state.dailyPnLSeeded,
    override: state.limitOverride,
    realized: state.dailyRealizedPnL,
    floating: usd,
    complete,
    maxLossUSD: maxLossUSD(),
    capUSD: state.settings.dailyProfitCapUSD,
    capBufferUSD: state.settings.capBufferUSD ?? 0,
  });
}

// Re-check the daily limits and lock trading if breached. Never closes
// positions (the ticker does that within a second). On incomplete floating
// data, only a realized-alone breach locks — a lock is never set on a partial
// floating figure.
export function evaluateNow(announce: boolean): void {
  let v = currentVerdict();
  let note = "";
  if (v.kind === "INCOMPLETE") {
    v = v.realizedOnly;
    note = " [realized only; awaiting quotes]";
  }
  if (v.kind !== "LOSS_BREACH" && v.kind !== "CAP_BREACH") return;

  const wasLocked = state.tradingLocked;
  const reason = v.kind === "CAP_BREACH" ? REASON_CAP : REASON_LOSS;
  const detail =
    v.kind === "CAP_BREACH"
      ? `Daily profit cap reached: +${v.total.toFixed(2)} USD (cap ${v.cap.toFixed(2)})${note}`
      : `Daily loss limit hit: ${v.total.toFixed(2)} USD (limit -${v.limit.toFixed(2)})${note}`;
  setTradingLock(true, reason);
  console.log(`[RISK] Trading locked - ${detail}`);
  if (announce && !wasLocked) {
    notify(`${detail}. New signals are blocked until the next broker trading day or /resume.`);
  }
}

// ---------------------------------------------------------------------------
// Realized P&L bookkeeping

// Apply a closing deal's net P&L to the daily counter, exactly once per dealId
// across duplicate execution events (one listener per live connection after a
// reconnect) AND across broker seeds that already included the deal.
export function recordClose(dealId: string, net: number): void {
  if (dealId && countedDeals.has(dealId)) {
    console.log(`[PNL] Ignoring duplicate close for deal ${dealId} (already counted)`);
    return;
  }
  if (dealId) countedDeals.add(dealId);
  if (seedInFlight && dealId) seedBuffer.push({ dealId, net });
  state.dailyRealizedPnL += net;
  console.log(`[PNL] Updated: ${net >= 0 ? "+" : ""}${net.toFixed(2)} (total: ${state.dailyRealizedPnL.toFixed(2)})`);
  evaluateNow(true);
}

// Replace the realized counter with the broker's own figure for the current
// broker day. Returns false on failure (caller decides fail-closed vs keep).
async function seed(conn: any): Promise<boolean> {
  seedInFlight = true;
  seedBuffer = [];
  try {
    const { net, dealIds } = await fetchRealizedPnLSince(conn, dayStartMs());
    for (const id of dealIds) countedDeals.add(id);
    // Closes that landed during the fetch but weren't in its window.
    let realized = net;
    for (const e of seedBuffer) {
      if (!dealIds.has(e.dealId)) realized += e.net;
    }
    state.dailyRealizedPnL = realized;
    state.dailyPnLSeeded = true;
    if (state.lockReason === REASON_SEED) setTradingLock(false);
    console.log(`[PNL] Seeded today's realized P&L from broker: ${realized.toFixed(2)} (${dealIds.size} deal(s))`);
    evaluateNow(true);
    return true;
  } catch (err: any) {
    console.warn(`[PNL] Seed failed: ${err.errorCode || err.message || "request failed"}`);
    return false;
  } finally {
    seedInFlight = false;
    seedBuffer = [];
  }
}

// Boot seed, fail-closed: until the broker confirms today's realized P&L,
// trading stays locked (the old code DISABLED all daily limits for the whole
// session on a failed seed — on a prop account that is the worst failure mode).
// Retries in the background until it succeeds or the day rolls over (which
// legitimately resets the counter to 0 and clears the lock).
async function seedUntilDone(conn: any): Promise<void> {
  if (await seed(conn)) return;
  if (!state.tradingLocked) {
    setTradingLock(true, REASON_SEED);
    notify(
      `Could not read today's P&L from the broker — trading is locked until it can be confirmed (retrying every ${SEED_RETRY_MS / 1000}s).`
    );
  }
  const retry = async () => {
    seedTimer = null;
    if (state.dailyPnLSeeded) return; // day rollover already resolved it
    if (!(await seed(connection))) {
      seedTimer = setTimeout(retry, SEED_RETRY_MS);
    }
  };
  seedTimer = setTimeout(retry, SEED_RETRY_MS);
}

// Reconnect re-seed: closes during the gap raised no execution event, so the
// in-memory counter can understate the day; the broker figure is authoritative.
// A failure here keeps the in-memory figure (unlike boot, we HAVE a number).
export async function reseedAfterReconnect(conn: any): Promise<void> {
  connection = conn;
  const before = state.dailyRealizedPnL;
  if (await seed(conn)) {
    if (before !== state.dailyRealizedPnL) {
      console.log(`[PNL] Re-seeded after reconnect: ${before.toFixed(2)} -> ${state.dailyRealizedPnL.toFixed(2)}`);
    }
  } else {
    console.warn(`[PNL] Could not re-seed after reconnect (keeping in-memory figure)`);
  }
}

// ---------------------------------------------------------------------------
// /resume override

// Clear pause and any daily lock; if a lock was cleared, daily limits stay OFF
// for the rest of the broker day (otherwise the very next signal would re-check
// the still-breached P&L and re-lock — the old /resume was a no-op after a
// realized breach). Used by the Telegram /resume and the Mini App alike.
export function resumeTrading(): { wasLocked: boolean } {
  const wasLocked = state.tradingLocked;
  state.paused = false;
  if (wasLocked) {
    setTradingLock(false);
    state.limitOverride = true;
    persistRuntime();
    console.log("[RISK] Daily-limit lock cleared by /resume — limits overridden until the next broker trading day");
  }
  return { wasLocked };
}

// ---------------------------------------------------------------------------
// Breach enforcement + broker-day schedule (the ticker)

async function forceCloseEverything(reason: string, detail: string): Promise<void> {
  closing = true;
  lossStreak = 0;
  capStreak = 0;
  // Lock BEFORE the closes land: the closing deals fire recordClose ->
  // evaluateNow(true), which sees the lock already set and stays quiet.
  setTradingLock(true, reason);
  const count = state.positions.size;
  console.log(`[RISK] ${detail}. Force-closing ${count} position(s) and cancelling resting orders.`);
  try {
    const { closed, failed } = await closeAllPositions();
    // A resting entry order surviving the sweep could fill minutes later and
    // reopen risk on a locked day. Kill those too (the old monitors didn't).
    const cancelled = await cancelAllRestingEntryOrders();
    notify(
      `${detail}. Force-closed ${closed}/${count} position(s)` +
        `${failed ? ` — ${failed} FAILED, check manually` : ""}` +
        `${cancelled ? `, cancelled ${cancelled} resting order(s)` : ""}. ` +
        `New signals blocked until the next broker trading day or /resume.`
    );
  } catch (err: any) {
    console.log(`[RISK] Force-close error: ${err.message}`);
  } finally {
    closing = false;
  }
}

// Start a fresh broker trading day: zero the counter, drop the counted-deal
// set, clear the lock and the /resume override. Triggered by the day KEY
// changing between ticks — immune to interval drift and to sleeping through
// the exact minute (the old 00:00-UTC check could skip a whole day).
function rolloverDay(newDay: string): void {
  currentDay = newDay;
  state.dailyRealizedPnL = 0;
  state.dailyPnLSeeded = true; // 0 IS the correct figure for a fresh day
  state.limitOverride = false;
  countedDeals.clear();
  lossStreak = 0;
  capStreak = 0;
  setTradingLock(false);
  persistRuntime();
  console.log("[RISK] New broker trading day — P&L, lock, and override reset");
}

// Flatten ahead of the broker's midnight so nothing is open (or resting) when
// the prop firm's daily counters roll over, then hold trading until the new day
// starts. Replaces the old startMidnightCheck, which was never even wired in.
async function preResetFlatten(): Promise<void> {
  closing = true;
  try {
    const count = state.positions.size;
    let closed = 0;
    if (count > 0) ({ closed } = await closeAllPositions());
    const cancelled = await cancelAllRestingEntryOrders();
    if (!state.tradingLocked) setTradingLock(true, REASON_ROLLOVER);
    console.log(`[RISK] Pre-reset flatten: closed ${closed}/${count} position(s), cancelled ${cancelled} resting order(s)`);
    if (count > 0 || cancelled > 0) {
      notify(
        `Broker day rollover in <${FLATTEN_MINUTES_BEFORE_RESET}m: closed ${closed}/${count} position(s)` +
          `${cancelled ? `, cancelled ${cancelled} resting order(s)` : ""}. Trading resumes with the new day.`
      );
    }
  } catch (err: any) {
    console.log(`[RISK] Pre-reset flatten error: ${err.message}`);
  } finally {
    closing = false;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();

  const dk = dayKey(now);
  if (dk !== currentDay) rolloverDay(dk);

  // Pre-reset flatten (prop-firm rollover protection). Opt-out via the
  // midnightFlatten setting: when off, positions ride through the broker's
  // midnight untouched. The window guard and once-per-day latch still apply.
  if (state.settings.midnightFlatten && inPreResetWindow(now) && flattenedDay !== dk && !closing) {
    flattenedDay = dk;
    await preResetFlatten();
    return;
  }

  if (state.positions.size === 0) {
    lossStreak = 0;
    capStreak = 0;
    return;
  }

  // Keep every open position streaming so floating P&L is complete. Idempotent.
  await subscribeOpenPositions();

  if (closing) return;

  const v = currentVerdict();
  // The force-close path acts only on COMPLETE data: a partial floating sum can
  // both miss a real breach and fire a false one. (Realized-alone lock breaches
  // are still handled by evaluateNow via recordClose.)
  if (v.kind !== "LOSS_BREACH" && v.kind !== "CAP_BREACH") {
    lossStreak = 0;
    capStreak = 0;
    return;
  }

  if (v.kind === "LOSS_BREACH") {
    capStreak = 0;
    if (++lossStreak < CONFIRM_TICKS) return;
    await forceCloseEverything(
      REASON_LOSS,
      `Daily loss limit hit: ${v.total.toFixed(2)} USD (limit -${v.limit.toFixed(2)})`
    );
  } else {
    lossStreak = 0;
    if (++capStreak < CONFIRM_TICKS) return;
    await forceCloseEverything(
      REASON_CAP,
      `Daily profit cap hit: +${v.total.toFixed(2)} USD (cap ${v.cap.toFixed(2)}, trigger ${v.trigger.toFixed(2)})`
    );
  }
}

// ---------------------------------------------------------------------------
// Startup

// Boot the engine: seed today's realized P&L (fail-closed, retrying), then run
// the 1s ticker. Await it BEFORE reconcilePositions() so the cap-TP re-arm
// logic sees a seeded counter.
export async function startRiskEngine(conn: any): Promise<void> {
  connection = conn;
  currentDay = dayKey();
  await seedUntilDone(conn);
  setInterval(() => {
    tick().catch((err) => console.log(`[RISK] Tick error: ${err.message}`));
  }, POLL_MS);
  console.log(`[RISK] Daily risk engine active (poll ${POLL_MS / 1000}s, confirm ${CONFIRM_TICKS} ticks, day ${currentDay})`);
}
