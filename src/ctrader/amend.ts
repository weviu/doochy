import { randomUUID } from "crypto";
import { state } from "../state";
import { quoteToUsd, getMarkPrice } from "./livePrices";
import { primaryAccountId } from "./accounts";
import { closePosition } from "../risk/midnightClose";

let connection: any = null;

export function setAmendConnection(conn: any): void {
  connection = conn;
}

// Number of decimal places in a price (used to round SL/TP to a valid tick).
function priceDigits(price: number): number {
  const s = String(price);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function round(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

// ProtoOAAmendPositionSLTPReq has no dedicated Res — success arrives as a
// ProtoOAExecutionEvent (ORDER_REPLACED) and failure as a ProtoOAOrderErrorEvent.
// sendCommand resolves immediately without confirming, so we listen for the
// real outcome here and log it.
async function sendAmend(positionId: number, fields: Record<string, any>, desc: string): Promise<void> {
  const pidStr = String(positionId);
  // The error event carries positionId="0" but DOES echo the request's
  // clientMsgId, so correlate rejections by msgId to avoid cross-talk between
  // concurrent amends on different positions.
  const msgId = randomUUID();

  const outcome = new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      connection.removeEventListener(execId);
      connection.removeEventListener(errId);
    };
    const timer = setTimeout(() => {
      cleanup();
      console.log(`[AMEND] ${desc}: no confirmation within 5s | Position #${positionId}`);
      resolve();
    }, 5_000);

    let execId: string;
    execId = connection.on("ProtoOAExecutionEvent", (event: any) => {
      const data = event.descriptor ?? event;
      // SL/TP amend responses carry positionId on the order object, not the
      // position object (which may be absent). Check both.
      const evtPositionId = String(data.position?.positionId ?? data.order?.positionId ?? "");
      if (evtPositionId !== pidStr) return;
      // Only the SL/TP order's own events count: the entry order's
      // ACCEPTED/FILLED events carry this same positionId.
      const orderType = data.order?.orderType;
      if (orderType !== "STOP_LOSS_TAKE_PROFIT" && orderType !== 4) return;
      // The FIRST amend on a position CREATES its SL/TP order and confirms as
      // ORDER_ACCEPTED (2); subsequent amends confirm as ORDER_REPLACED (4).
      const et = data.executionType;
      if (et === "ORDER_ACCEPTED" || et === 2 || et === "ORDER_REPLACED" || et === 4) {
        cleanup();
        console.log(`[AMEND] ${desc}: confirmed | Position #${positionId}`);
        resolve();
      }
    });

    let errId: string;
    errId = connection.on("ProtoOAOrderErrorEvent", (event: any) => {
      const data = event.descriptor ?? event;
      if (data.clientMsgId !== msgId) return;
      cleanup();
      console.log(`[AMEND] ${desc}: REJECTED ${data.errorCode} — ${data.description} | Position #${positionId}`);
      resolve();
    });
  });

  await connection.sendCommand("ProtoOAAmendPositionSLTPReq", {
    ctidTraderAccountId: primaryAccountId(),
    positionId,
    ...fields,
  }, msgId);
  await outcome;
}

export async function amendPositionSLTP(
  positionId: number,
  symbol: string,
  entryPrice: number,
  direction: "BUY" | "SELL",
  signal: { sl?: number; tp?: number }
): Promise<void> {
  if (!connection) {
    console.log("[AMEND] No cTrader connection");
    return;
  }

  // SL/TP are the signal's own absolute levels (scanner/channel/manual), passed
  // straight through by the caller. There is no percentage fallback: a signal with
  // no SL/TP is rejected upstream at the gate, so anything reaching here already
  // carries real levels. The profit-cap logic below may still add/tighten the TP.
  let sl: number | null = signal.sl ?? null;
  let tp: number | null = signal.tp ?? null;

  if (sl && direction === "BUY" && sl >= entryPrice) {
    console.log(`[AMEND] Invalid SL for BUY: ${sl} >= entry ${entryPrice}. Skipping SL.`);
    sl = null;
  }
  if (sl && direction === "SELL" && sl <= entryPrice) {
    console.log(`[AMEND] Invalid SL for SELL: ${sl} <= entry ${entryPrice}. Skipping SL.`);
    sl = null;
  }
  if (tp && direction === "BUY" && tp <= entryPrice) {
    console.log(`[AMEND] Invalid TP for BUY: ${tp} <= entry ${entryPrice}. Skipping TP.`);
    tp = null;
  }
  if (tp && direction === "SELL" && tp >= entryPrice) {
    console.log(`[AMEND] Invalid TP for SELL: ${tp} >= entry ${entryPrice}. Skipping TP.`);
    tp = null;
  }

  // Round SL/TP to the entry price's precision. Computing distances introduces
  // float junk (e.g. 4333.099999999999) which the broker silently rejects.
  const digits = priceDigits(entryPrice);
  if (sl) sl = round(sl, digits);
  if (tp) tp = round(tp, digits);

  // If a profit cap is configured, compute the price at which this position
  // would exhaust the remaining daily headroom. Use whichever TP triggers first
  // (closer to entry). This implements the hard cap: e.g. cap=$400, realized=$390
  // → remaining=$10, position closes the moment it earns $10 regardless of normal TP.
  const cap = state.settings.dailyProfitCapUSD;
  if (cap > 0 && state.dailyPnLSeeded) {
    const pos = state.positions.get(positionId);
    const units = pos?.volumeCents ? pos.volumeCents / 100 : 0;
    // Headroom left before the cap, minus the same safety buffer the live monitor
    // uses, so the broker-side TP (the only protection while the bot is down)
    // also lands under the cap.
    let remaining = cap - state.dailyRealizedPnL - (state.settings.capBufferUSD ?? 0);
    // Split the headroom across all currently-open positions. If the bot is down
    // when several hit their TP near-simultaneously, each banks only its share, so
    // the combined realized still lands at (or under) the cap instead of N× over.
    const openCount = Math.max(1, state.positions.size);
    remaining = remaining / openCount;
    // remaining is USD headroom; the price offset is in the symbol's QUOTE currency.
    // factor converts quote->USD (1 for USD-quoted), so quote-currency headroom is
    // remaining/factor and the price distance is remaining/(units*factor). Skip the
    // cap TP if no rate is available rather than place it at a wrong (unconverted)
    // level — the live cap monitor still protects the position.
    const factor = quoteToUsd(symbol);
    if (units > 0 && remaining > 0 && factor != null) {
      const diff = round(remaining / (units * factor), digits);
      const capTp = round(direction === "BUY" ? entryPrice + diff : entryPrice - diff, digits);
      if (tp === null) {
        tp = capTp;
        console.log(`[AMEND] Cap TP ${capTp} set (headroom/${openCount}: ${remaining.toFixed(2)}) | Position #${positionId}`);
      } else if (Math.abs(capTp - entryPrice) < Math.abs(tp - entryPrice)) {
        console.log(`[AMEND] Cap TP ${capTp} overrides normal TP ${tp} (headroom/${openCount}: ${remaining.toFixed(2)}) | Position #${positionId}`);
        tp = capTp;
      }
    }
  }

  // Elapsed-time-aware minhold: if the position has already been open past the
  // hold period (e.g. re-amend after a sibling closes), delay is 0.
  const openTime = state.positions.get(positionId)?.openTime ?? Date.now();
  const elapsed = Date.now() - openTime;
  const delayMs = Math.max(0, (state.settings.minHoldSeconds ?? 60) * 1000 - elapsed);

  // With no min-hold delay, set SL and TP in a SINGLE amend. cTrader's amend
  // replaces the full SL/TP state anyway, so one call is cleaner and avoids a
  // redundant SL-only amend that the broker doesn't always confirm in time.
  if (delayMs === 0) {
    const fields: Record<string, any> = {};
    if (sl) fields.stopLoss = sl;
    if (tp) fields.takeProfit = tp;
    if (Object.keys(fields).length) {
      await sendAmend(positionId, fields, `SL ${sl ?? "—"} / TP ${tp ?? "—"}`);
      const pos = state.positions.get(positionId);
      if (pos) { if (sl) pos.sl = sl; if (tp) pos.tp = tp; }
    }
    return;
  }

  // Otherwise: set SL immediately, then TP after the min-hold delay.
  if (sl) {
    await sendAmend(positionId, { stopLoss: sl }, `SL ${sl}`);
    const pos = state.positions.get(positionId);
    if (pos) pos.sl = sl;
  }

  if (tp) {
    console.log(`[AMEND] TP will be set in ${delayMs / 1000}s (min hold) | Position #${positionId}`);
    const minHoldMs = (state.settings.minHoldSeconds ?? 60) * 1000;

    setTimeout(async () => {
      if (!state.positions.has(positionId)) {
        console.log(`[AMEND] TP skipped - position #${positionId} already closed`);
        return;
      }

      // Prop-rule insurance: the position MUST have been held for the full
      // min-hold before it can close. delayMs is computed to land exactly on
      // that boundary, so this should never trigger — but a hard guard on a
      // prop rule is cheap. If somehow early, reschedule for the remainder.
      const openTime = state.positions.get(positionId)?.openTime ?? Date.now();
      const heldMs = Date.now() - openTime;
      if (heldMs < minHoldMs) {
        const remaining = minHoldMs - heldMs;
        console.log(`[AMEND] TP deferral fired ${remaining / 1000}s early; rescheduling | Position #${positionId}`);
        setTimeout(() => { void applyDeferredTp(positionId, symbol, direction, sl, tp!); }, remaining);
        return;
      }

      await applyDeferredTp(positionId, symbol, direction, sl, tp);
    }, delayMs);
  }

  if (!sl && !tp) {
    console.log(`[AMEND] No SL/TP to set for position #${positionId}`);
  }
}

// Apply a position's TP once the min-hold has elapsed. Callers guarantee the
// hold is satisfied, so closing here is prop-compliant.
//
// The catch this handles: while the TP was withheld during the hold, price can
// reach the target. Sending a takeProfit that the market has already passed is
// rejected by the broker (the level is on the wrong side of the current price),
// which would leave the position SL-only and let it give the profit back. So if
// the target is already reached, close at market to realise it instead. The
// side-correct mark (bid for a BUY, ask for a SELL) is the exact price the TP
// would trigger on. If no live quote is available, fall back to attempting the
// amend, which is no worse than the previous behaviour.
async function applyDeferredTp(
  positionId: number,
  symbol: string,
  direction: "BUY" | "SELL",
  sl: number | null,
  tp: number
): Promise<void> {
  if (!connection || !state.positions.has(positionId)) {
    console.log(`[AMEND] TP skipped - position #${positionId} closed or no connection`);
    return;
  }

  const mark = getMarkPrice(symbol, direction);
  const crossed = mark != null && (direction === "BUY" ? mark >= tp : mark <= tp);
  if (crossed) {
    console.log(`[AMEND] TP ${tp} already reached during min-hold (mark ${mark}); closing at market to realise it | Position #${positionId}`);
    const ok = await closePosition(positionId);
    if (!ok) {
      // Close failed (e.g. transient broker error). Try to at least set the TP
      // so the position isn't left unprotected on the upside; the broker may
      // accept it and trigger immediately, or reject it (logged), in which case
      // the SL and daily-loss limit still cap the downside.
      const fields: Record<string, any> = { takeProfit: tp };
      if (sl) fields.stopLoss = sl;
      await sendAmend(positionId, fields, `TP ${tp} (fallback after failed market close)`);
      const pos = state.positions.get(positionId);
      if (pos) pos.tp = tp;
    }
    return;
  }

  // Normal case: target not yet reached. cTrader's amend REPLACES the full
  // SL/TP state, so re-send the existing SL or it gets wiped when we set the TP.
  const fields: Record<string, any> = { takeProfit: tp };
  if (sl) fields.stopLoss = sl;
  await sendAmend(positionId, fields, `TP ${tp}${sl ? ` (SL preserved ${sl})` : ""}`);
  const pos = state.positions.get(positionId);
  if (pos) pos.tp = tp;
}
