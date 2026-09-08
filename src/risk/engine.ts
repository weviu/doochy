import { state, setTradingLock, persistRuntime, RuntimeState, primaryRuntimes, runtimeFor } from "../state";
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
// Account-scoped: one process trades several accounts, and each has its OWN
// realized P&L, lock, streaks, seeds, and broker-day schedule. Every function
// takes the account's RuntimeState (or a ctid), and the ticker runs once per
// account. Settings are shared; P&L and limits are not.
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

// One connection carries the whole process's cTrader session; every account's
// requests go over it (each with its own account-level auth).
let connection: any = null;

// Per-account engine bookkeeping. All of this is specific to ONE account's day
// and must not be shared: a breach on account A must not streak-latch account B.
interface EngineCtx {
  // Closing deals already applied to the realized counter — by a live close
  // event OR by a broker seed whose window included them. One set per account,
  // so the seed/event races that double-counted before are structurally
  // impossible. Cleared at the day rollover (when the counter it guards resets).
  countedDeals: Set<string>;
  // Seed/event race: a close landing while a seed fetch is in flight may or may
  // not be inside the fetched window. Buffer those events; when the seed result
  // replaces the counter, re-apply only the ones the fetch did NOT include.
  seedInFlight: boolean;
  seedBuffer: { dealId: string; net: number }[];
  lossStreak: number;
  capStreak: number;
  closing: boolean; // a force-close sweep is in flight; don't start another
  currentDay: string;
  flattenedDay: string | null; // pre-reset flatten already ran for this day key
  seedTimer: ReturnType<typeof setTimeout> | null;
  catchUpTimer: ReturnType<typeof setTimeout> | null;
}

const ctxs = new Map<number, EngineCtx>();

function ctxFor(rt: RuntimeState): EngineCtx {
  let ctx = ctxs.get(rt.ctid);
  if (!ctx) {
    ctx = {
      countedDeals: new Set(),
      seedInFlight: false,
      seedBuffer: [],
      lossStreak: 0,
      capStreak: 0,
      closing: false,
      currentDay: dayKey(),
      flattenedDay: null,
      seedTimer: null,
      catchUpTimer: null,
    };
    ctxs.set(rt.ctid, ctx);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Floating P&L

// Unrealized P&L (USD) across ONE account's open positions — deliberately not
// filtered by allowedSymbols: a losing position on a de-listed symbol is still
// real money against the daily limit (the old code silently excluded them).
// `complete` is false when any position lacks a live quote or a USD conversion
// rate; the sum then omits it and callers must not force-close on the partial
// figure.
//
// Booked costs (entry-side commission, accrued swap — stored SIGNED on the
// position, in account currency) are included: the daily limits are judged on
// NET realized P&L, so enforcing them on a gross floating figure understates
// every loss by the costs. The exit-side commission (charged on close) is the
// remaining, accepted approximation.
export function floatingPnL(rt: RuntimeState): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const pos of rt.positions.values()) {
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

// Cross-account convenience for display (multi-account: the SUM across every
// traded account). Display only — per-account limits are enforced with
// floatingPnL(rt).
export function floatingPnLUsd(): number {
  let total = 0;
  for (const rt of primaryRuntimes()) total += floatingPnL(rt).usd;
  return total;
}

export function maxLossUSD(): number {
  return state.settings.maxDailyLossUSD;
}

// ---------------------------------------------------------------------------
// Evaluation (lock-only path — the gate and close events call this; the ticker
// below additionally force-closes)

function currentVerdict(rt: RuntimeState): LimitVerdict {
  const { usd, complete } = floatingPnL(rt);
  return decideLimits({
    seeded: rt.dailyPnLSeeded,
    override: rt.limitOverride,
    realized: rt.dailyRealizedPnL,
    floating: usd,
    complete,
    maxLossUSD: maxLossUSD(),
    capUSD: state.settings.dailyProfitCapUSD,
    capBufferUSD: state.settings.capBufferUSD ?? 0,
  });
}

// Re-check the daily limits for ONE account and lock trading if breached. Never
// closes positions (the ticker does that within a second). On incomplete
// floating data, only a realized-alone breach locks — a lock is never set on a
// partial floating figure.
export function evaluateNow(announce: boolean, rt: RuntimeState): void {
  let v = currentVerdict(rt);
  let note = "";
  if (v.kind === "INCOMPLETE") {
    v = v.realizedOnly;
    note = " [realized only; awaiting quotes]";
  }
  if (v.kind !== "LOSS_BREACH" && v.kind !== "CAP_BREACH") return;

  const wasLocked = rt.tradingLocked;
  const reason = v.kind === "CAP_BREACH" ? REASON_CAP : REASON_LOSS;
  const detail =
    v.kind === "CAP_BREACH"
      ? `Daily profit cap reached: +${v.total.toFixed(2)} USD (cap ${v.cap.toFixed(2)})${note}`
      : `Daily loss limit hit: ${v.total.toFixed(2)} USD (limit -${v.limit.toFixed(2)})${note}`;
  setTradingLock(rt, true, reason);
  console.log(`[RISK] Trading locked (account ${rt.ctid}) - ${detail}`);
  if (announce && !wasLocked) {
    notify(`${detail}. New signals are blocked until the next broker trading day or /resume.`);
  }
}

// ---------------------------------------------------------------------------
// Realized P&L bookkeeping

// Apply a closing deal's net P&L to ONE account's daily counter, exactly once
// per dealId across duplicate execution events (one listener per live
// connection after a reconnect) AND across broker seeds that already included
// the deal.
export function recordClose(ctid: number, dealId: string, net: number): void {
  const rt = runtimeFor(ctid);
  const ctx = ctxFor(rt);
  if (dealId && ctx.countedDeals.has(dealId)) {
    console.log(`[PNL] Ignoring duplicate close for deal ${dealId} (already counted)`);
    return;
  }
  if (dealId) ctx.countedDeals.add(dealId);
  if (ctx.seedInFlight && dealId) ctx.seedBuffer.push({ dealId, net });
  rt.dailyRealizedPnL += net;
  console.log(`[PNL] Updated (account ${ctid}): ${net >= 0 ? "+" : ""}${net.toFixed(2)} (total: ${rt.dailyRealizedPnL.toFixed(2)})`);
  evaluateNow(true, rt);
}

// Replace ONE account's realized counter with the broker's own figure for the
// current broker day. Returns false on failure (caller decides fail-closed vs
// keep).
async function seed(conn: any, rt: RuntimeState): Promise<boolean> {
  const ctx = ctxFor(rt);
  ctx.seedInFlight = true;
  ctx.seedBuffer = [];
  try {
    const { net, dealIds } = await fetchRealizedPnLSince(conn, rt.ctid, dayStartMs());
    for (const id of dealIds) ctx.countedDeals.add(id);
    // Closes that landed during the fetch but weren't in its window.
    let realized = net;
    for (const e of ctx.seedBuffer) {
      if (!dealIds.has(e.dealId)) realized += e.net;
    }
    rt.dailyRealizedPnL = realized;
    rt.dailyPnLSeeded = true;
    if (rt.lockReason === REASON_SEED) setTradingLock(rt, false);
    console.log(`[PNL] Seeded today's realized P&L (account ${rt.ctid}): ${realized.toFixed(2)} (${dealIds.size} deal(s))`);
    evaluateNow(true, rt);
    return true;
  } catch (err: any) {
    console.warn(`[PNL] Seed failed (account ${rt.ctid}): ${err.errorCode || err.message || "request failed"}`);
    return false;
  } finally {
    ctx.seedInFlight = false;
    ctx.seedBuffer = [];
  }
}

// Boot seed for ONE account, fail-closed: until the broker confirms today's
// realized P&L, trading stays locked (the old code DISABLED all daily limits for
// the whole session on a failed seed — on a prop account that is the worst
// failure mode). Retries in the background until it succeeds or the day rolls
// over (which legitimately resets the counter to 0 and clears the lock).
async function seedUntilDone(conn: any, rt: RuntimeState): Promise<void> {
  if (await seed(conn, rt)) return;
  if (!rt.tradingLocked) {
    setTradingLock(rt, true, REASON_SEED);
    notify(
      `Could not read today's P&L for account ${rt.ctid} from the broker — trading is locked until it can be confirmed (retrying every ${SEED_RETRY_MS / 1000}s).`
    );
  }
  const retry = async () => {
    const ctx = ctxFor(rt);
    ctx.seedTimer = null;
    if (rt.dailyPnLSeeded) return; // day rollover already resolved it
    if (!(await seed(connection, rt))) {
      ctx.seedTimer = setTimeout(retry, SEED_RETRY_MS);
    }
  };
  ctxFor(rt).seedTimer = setTimeout(retry, SEED_RETRY_MS);
}

// Reconnect re-seed for every traded account: closes during the gap raised no
// execution event, so the in-memory counters can understate the day; the broker
// figure is authoritative. A failure keeps the in-memory figure (unlike boot, we
// HAVE a number).
export async function reseedAfterReconnect(conn: any): Promise<void> {
  connection = conn;
  for (const rt of primaryRuntimes()) {
    const before = rt.dailyRealizedPnL;
    if (await seed(conn, rt)) {
      if (before !== rt.dailyRealizedPnL) {
        console.log(`[PNL] Re-seeded after reconnect (account ${rt.ctid}): ${before.toFixed(2)} -> ${rt.dailyRealizedPnL.toFixed(2)}`);
      }
    } else {
      console.warn(`[PNL] Could not re-seed account ${rt.ctid} after reconnect (keeping in-memory figure)`);
    }
  }
}

// Some close events (manual closes, /closeall, reversals) arrive without
// closePositionDetail, so recordClose has nothing to add. Instead of letting the
// daily realized counters drift, fetch the broker's own figure once the broker
// has had a moment to write the closing deal. Debounced so a burst of such
// events triggers only one catch-up request.
export function requestRealizedCatchUp(rt: RuntimeState, reason: string): void {
  const ctx = ctxFor(rt);
  if (ctx.catchUpTimer) clearTimeout(ctx.catchUpTimer);
  ctx.catchUpTimer = setTimeout(async () => {
    ctx.catchUpTimer = null;
    if (!connection) return;
    const before = rt.dailyRealizedPnL;
    if (await seed(connection, rt)) {
      if (before !== rt.dailyRealizedPnL) {
        console.log(`[PNL] Caught up realized P&L after ${reason} (account ${rt.ctid}): ${before.toFixed(2)} -> ${rt.dailyRealizedPnL.toFixed(2)}`);
      }
    } else {
      console.warn(`[PNL] Could not catch up realized P&L after ${reason} (account ${rt.ctid})`);
    }
  }, 3_000);
}

// ---------------------------------------------------------------------------
// /resume override

// Clear pause (global) and any daily lock for ONE account; if a lock was
// cleared, that account's daily limits stay OFF for the rest of the broker day
// (otherwise the very next signal would re-check the still-breached P&L and
// re-lock — the old /resume was a no-op after a realized breach). Used by the
// Telegram /resume and the Mini App alike.
export function resumeTrading(rt: RuntimeState): { wasLocked: boolean } {
  const wasLocked = rt.tradingLocked;
  state.paused = false;
  if (wasLocked) {
    setTradingLock(rt, false);
    rt.limitOverride = true;
    persistRuntime();
    console.log(`[RISK] Daily-limit lock cleared by /resume (account ${rt.ctid}) — limits overridden until the next broker trading day`);
  }
  return { wasLocked };
}

// ---------------------------------------------------------------------------
// Breach enforcement + broker-day schedule (the ticker)

async function forceCloseEverything(rt: RuntimeState, reason: string, detail: string): Promise<void> {
  const ctx = ctxFor(rt);
  ctx.closing = true;
  ctx.lossStreak = 0;
  ctx.capStreak = 0;
  // Lock BEFORE the closes land: the closing deals fire recordClose ->
  // evaluateNow(true), which sees the lock already set and stays quiet.
  setTradingLock(rt, true, reason);
  const count = rt.positions.size;
  console.log(`[RISK] ${detail} (account ${rt.ctid}). Force-closing ${count} position(s) and cancelling resting orders.`);
  try {
    const { closed, failed } = await closeAllPositions(rt);
    // A resting entry order surviving the sweep could fill minutes later and
    // reopen risk on a locked day. Kill those too (the old monitors didn't).
    const cancelled = await cancelAllRestingEntryOrders(rt);
    notify(
      `${detail}. Force-closed ${closed}/${count} position(s)` +
        `${failed ? ` — ${failed} FAILED, check manually` : ""}` +
        `${cancelled ? `, cancelled ${cancelled} resting order(s)` : ""}. ` +
        `New signals blocked until the next broker trading day or /resume.`
    );
  } catch (err: any) {
    console.log(`[RISK] Force-close error: ${err.message}`);
  } finally {
    ctx.closing = false;
  }
}

// Start a fresh broker trading day for ONE account: zero the counter, drop the
// counted-deal set, clear the lock and the /resume override. Triggered by the
// day KEY changing between ticks — immune to interval drift and to sleeping
// through the exact minute (the old 00:00-UTC check could skip a whole day).
function rolloverDay(rt: RuntimeState, newDay: string): void {
  const ctx = ctxFor(rt);
  ctx.currentDay = newDay;
  rt.dailyRealizedPnL = 0;
  rt.dailyPnLSeeded = true; // 0 IS the correct figure for a fresh day
  rt.limitOverride = false;
  ctx.countedDeals.clear();
  ctx.lossStreak = 0;
  ctx.capStreak = 0;
  setTradingLock(rt, false);
  persistRuntime();
  console.log(`[RISK] New broker trading day (account ${rt.ctid}) — P&L, lock, and override reset`);
}

// Flatten ONE account ahead of the broker's midnight so nothing is open (or
// resting) when the prop firm's daily counters roll over, then hold trading
// until the new day starts. Replaces the old startMidnightCheck, which was never
// even wired in.
async function preResetFlatten(rt: RuntimeState): Promise<void> {
  const ctx = ctxFor(rt);
  ctx.closing = true;
  try {
    const count = rt.positions.size;
    let closed = 0;
    if (count > 0) ({ closed } = await closeAllPositions(rt));
    const cancelled = await cancelAllRestingEntryOrders(rt);
    if (!rt.tradingLocked) setTradingLock(rt, true, REASON_ROLLOVER);
    console.log(`[RISK] Pre-reset flatten (account ${rt.ctid}): closed ${closed}/${count} position(s), cancelled ${cancelled} resting order(s)`);
    if (count > 0 || cancelled > 0) {
      notify(
        `Broker day rollover in <${FLATTEN_MINUTES_BEFORE_RESET}m: closed ${closed}/${count} position(s)` +
          `${cancelled ? `, cancelled ${cancelled} resting order(s)` : ""}. Trading resumes with the new day.`
      );
    }
  } catch (err: any) {
    console.log(`[RISK] Pre-reset flatten error: ${err.message}`);
  } finally {
    ctx.closing = false;
  }
}

async function tickFor(rt: RuntimeState): Promise<void> {
  const ctx = ctxFor(rt);
  const now = Date.now();

  const dk = dayKey(now);
  if (dk !== ctx.currentDay) rolloverDay(rt, dk);

  // Pre-reset flatten (prop-firm rollover protection). Opt-out via the
  // midnightFlatten setting: when off, positions ride through the broker's
  // midnight untouched. The window guard and once-per-day latch still apply.
  if (state.settings.midnightFlatten && inPreResetWindow(now) && ctx.flattenedDay !== dk && !ctx.closing) {
    ctx.flattenedDay = dk;
    await preResetFlatten(rt);
    return;
  }

  if (rt.positions.size === 0) {
    ctx.lossStreak = 0;
    ctx.capStreak = 0;
    return;
  }

  // Keep every open position streaming so floating P&L is complete. Idempotent.
  await subscribeOpenPositions(rt);

  if (ctx.closing) return;

  const v = currentVerdict(rt);
  // The force-close path acts only on COMPLETE data: a partial floating sum can
  // both miss a real breach and fire a false one. (Realized-alone lock breaches
  // are still handled by evaluateNow via recordClose.)
  if (v.kind !== "LOSS_BREACH" && v.kind !== "CAP_BREACH") {
    ctx.lossStreak = 0;
    ctx.capStreak = 0;
    return;
  }

  if (v.kind === "LOSS_BREACH") {
    ctx.capStreak = 0;
    if (++ctx.lossStreak < CONFIRM_TICKS) return;
    await forceCloseEverything(
      rt,
      REASON_LOSS,
      `Daily loss limit hit: ${v.total.toFixed(2)} USD (limit -${v.limit.toFixed(2)})`
    );
  } else {
    ctx.lossStreak = 0;
    if (++ctx.capStreak < CONFIRM_TICKS) return;
    await forceCloseEverything(
      rt,
      REASON_CAP,
      `Daily profit cap hit: +${v.total.toFixed(2)} USD (cap ${v.cap.toFixed(2)}, trigger ${v.trigger.toFixed(2)})`
    );
  }
}

// ---------------------------------------------------------------------------
// Startup

// Boot the engine: seed today's realized P&L for every traded account
// (fail-closed, retrying), then run the 1s ticker over all of them. Awaited
// BEFORE reconcilePositions() so the cap-TP re-arm logic sees seeded counters.
export async function startRiskEngine(conn: any): Promise<void> {
  connection = conn;
  const accounts = primaryRuntimes();
  for (const rt of accounts) {
    ctxFor(rt).currentDay = dayKey();
    await seedUntilDone(conn, rt);
  }
  setInterval(() => {
    Promise.all(primaryRuntimes().map((rt) => tickFor(rt).catch((err) => console.log(`[RISK] Tick error: ${err.message}`))));
  }, POLL_MS);
  console.log(`[RISK] Daily risk engine active over ${accounts.length} account(s) (poll ${POLL_MS / 1000}s, confirm ${CONFIRM_TICKS} ticks)`);
}