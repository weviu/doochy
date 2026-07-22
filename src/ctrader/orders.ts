import { randomUUID } from "crypto";
import { state, symbolIdFor } from "../state";
import { ParsedSignal } from "../signals/types";
import { amendPositionSLTP } from "./amend";
import { updateDailyPnL, floatingPnL } from "../risk/dailyLoss";
import { fetchTrader } from "./account";
import { recordStopLoss } from "../risk/cooldown";
import { recordLoss } from "../risk/reentryCooldown";
import { subscribeSpots, getMarkPrice, quoteToUsd, canValueInUsd } from "./livePrices";
import { notify } from "../bot/notify";
import { inEntryBlackout } from "../risk/news/calendar";
import { effectiveTimeExitMin, recordTimedPosition, clearTimedPosition, restingExpiryMs } from "../risk/timeExit";

// How close our live mark must be to a feed signal's target (as % of the target)
// to fill at market instead of resting an order at the target and waiting for
// price to reach it. Fixed in code (not a user setting) so behaviour is identical
// across every deployment. 0 would mean "always market".
export const ENTRY_TOLERANCE_PERCENT = 0.15;

// One bar of a signal timeframe ("30m", "15m", "1h", "4h", "1d", "1w") in ms, or
// null if it can't be parsed - in which case the staleness guard is skipped and
// the resting order stays GOOD_TILL_CANCEL. Minutes/hours/days/weeks only (the
// scanner's timeframes); case-insensitive, m = minute.
function timeframeMs(tf: string | undefined): number | null {
  if (!tf) return null;
  const m = /^(\d+)\s*([mhdw])$/i.exec(tf.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const unit = m[2].toLowerCase();
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * mult;
}

// Send a Telegram message when an order fills (toggled by /notifications). SL/TP
// are the levels being applied: the explicit values passed in (resting orders) or
// the signal's own SL/TP (the scanner/channel/manual levels that drive execution).
function notifyFill(
  kind: string,
  signal: ParsedSignal,
  lots: number,
  entry: number,
  positionId: number,
  riskUsd: number,
  sl?: number | null,
  tp?: number | null
): void {
  if (!state.settings.notifyFills) return;
  const slP = sl ?? signal.sl;
  const tpP = tp ?? signal.tp;
  const digits = (entry.toString().split(".")[1] || "").length || 2;
  const f = (n: number | null | undefined) => (n != null ? n.toFixed(digits) : "-");
  notify(
    `${kind}\n` +
    `${signal.direction} ${signal.symbol} ${lots.toFixed(2)} lots @ ${entry}\n` +
    `SL ${f(slP)}  TP ${f(tpP)}\n` +
    `Risk ~$${riskUsd.toFixed(0)}  Position #${positionId}`
  );
}

let connection: any = null;

// Closing deals already added to the daily realized counter, so a duplicate
// execution event (one per live connection after a reconnect) can't count the
// same close twice. Cleared on the daily reset, which is also when the counter
// it guards goes back to zero.
const countedDeals = new Set<string>();
export function clearCountedDeals(): void { countedDeals.clear(); }

export function getConnection(): any { return connection; }

export function setConnection(conn: any): void {
  console.log('[ORDERS] setConnection called, sendCommand type:', typeof conn.sendCommand);
  connection = conn;

  // Track position closes (SL/TP hit, manual close, stop-out) so they're
  // removed from state.positions — otherwise the open-position count only ever
  // grows and the max-positions gate eventually rejects everything.
  conn.on("ProtoOAExecutionEvent", (event: any) => {
    const data = event.descriptor ?? event;
    const pos = data.position;
    if (!pos?.positionId) return;
    const positionId = Number(pos.positionId);
    if (pos.positionStatus === "POSITION_STATUS_CLOSED" || pos.positionStatus === 2) {
      // Realized P&L from the closing deal drives the daily loss/profit limits.
      const cpd = data.deal?.closePositionDetail;
      let net = 0;
      if (cpd) {
        const div = Math.pow(10, Number(cpd.moneyDigits ?? 2));
        net = (Number(cpd.grossProfit || 0) + Number(cpd.swap || 0) + Number(cpd.commission || 0)) / div;
        // Count each closing deal ONCE. A reconnect wires a fresh connection and
        // registers another listener on it, so without this the same close is
        // added to the daily counter once per live connection — which silently
        // walked the daily loss limit past its real value and locked trading on
        // a loss that had already been counted.
        const dealId = String(data.deal?.dealId ?? "");
        if (dealId && countedDeals.has(dealId)) {
          console.log(`[PNL] Ignoring duplicate close event for deal ${dealId} (already counted)`);
        } else {
          if (dealId) countedDeals.add(dealId);
          updateDailyPnL(net);
        }
      }

      // Per-symbol consecutive-loss protection. A stop-loss exit = the close came
      // from the SL/TP order (or a forced stop-out) and the trade lost money;
      // that excludes take-profits (net >= 0) and manual closes (no SL/TP order).
      const tracked = state.positions.get(positionId);
      const ord = data.order;
      const viaStopOrder = ord?.isStopOut || ord?.orderType === "STOP_LOSS_TAKE_PROFIT";
      if (tracked && viaStopOrder && net < 0) {
        recordStopLoss(tracked.symbol);
      }

      // Re-entry cooldown: ANY losing close (SL, stop-out, manual, forced) blocks
      // reopening the same symbol+direction for the configured window. Wins
      // (net >= 0) never trigger it.
      if (tracked && net < 0) {
        recordLoss(tracked.symbol, tracked.direction);
      }

      if (state.positions.delete(positionId)) {
        console.log(`[POSITIONS] Closed #${positionId}. Open now: ${state.positions.size}`);
      }
      // Forget any time-exit timer for this position however it closed (SL, TP,
      // stop-out, manual, timer, news flatten) so a stale timer can't act on a
      // re-used id later. Idempotent (no-op if it wasn't a timed position).
      clearTimedPosition(positionId);

      // When a position closes, realized P&L changes — the remaining cap headroom
      // shifts. Re-amend all remaining positions so their cap TPs tighten (or
      // loosen) to reflect the new headroom. Only fires when cap is enabled.
      if (state.settings.dailyProfitCapUSD > 0 && state.dailyPnLSeeded && state.positions.size > 0) {
        for (const [pid, p] of state.positions.entries()) {
          // Re-send the position's own SL and TP so the amend (which replaces the
          // full SL/TP state) preserves them; the cap logic inside tightens the TP
          // if the reduced headroom now bites before the normal target.
          amendPositionSLTP(pid, p.symbol, p.entryPrice, p.direction, {
            sl: p.sl ?? undefined,
            tp: p.tp ?? undefined,
          });
        }
      }
    } else if (
      (pos.positionStatus === "POSITION_STATUS_OPEN" || pos.positionStatus === 1) &&
      !state.positions.has(positionId)
    ) {
      // A position we don't already track just opened. Orders WE place are added
      // to state.positions synchronously by executeSignal, so this only catches
      // positions opened directly in the cTrader platform (outside the bot). Left
      // untracked they're invisible to /positions, the mini-app, and the
      // max-positions gate until the next restart/reconnect. Re-run reconcile
      // (rather than a second, drift-prone position-builder) so the same
      // allowed-symbol and USD-valuability rules apply as at boot.
      console.log(`[POSITIONS] Untracked position #${positionId} opened (external fill); reconciling.`);
      void adoptExternalPositions();
    }
  });
}

// Reconcile triggered by an external fill event, guarded so a burst of fills
// doesn't launch overlapping reconciles. Any position skipped by reconcile's
// filters (non-allowed symbol, non-USD-valuable) is intentionally left untracked,
// exactly as at boot.
let adoptingExternal = false;
export async function adoptExternalPositions(): Promise<void> {
  if (adoptingExternal) return;
  adoptingExternal = true;
  try {
    await reconcilePositions();
  } catch (err: any) {
    console.warn(`[POSITIONS] External-fill reconcile failed: ${err?.message || err}`);
  } finally {
    adoptingExternal = false;
  }
}

// Cancel every resting (unfilled) order at the broker for `symbol`. Used by the
// pre-news flatten: closing open positions isn't enough if a stop/limit is resting
// that would fill INTO the news spike. We can't cancel from state.pendingOrders
// (it never stored the broker orderId), so we reconcile to learn the live order
// ids and cancel each one, then drop our in-memory pending markers for the symbol.
// Returns how many cancels were sent. Never throws.
export async function cancelRestingOrdersForSymbol(symbol: string): Promise<number> {
  if (!connection) return 0;
  const symbolId = symbolIdFor(symbol);
  if (!symbolId) return 0;

  let res: any;
  try {
    res = await connection.sendCommand("ProtoOAReconcileReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    });
  } catch (err: any) {
    console.warn(`[news] reconcile (for order-cancel) failed: ${err.errorCode || err.message || "request failed"}`);
    return 0;
  }

  let cancelled = 0;
  for (const o of res.order || []) {
    if (Number(o.tradeData?.symbolId) !== Number(symbolId)) continue;
    const orderId = Number(o.orderId);
    if (!orderId) continue;
    try {
      await connection.sendCommand("ProtoOACancelOrderReq", {
        ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
        orderId,
      });
      cancelled++;
      console.log(`[news] cancelled resting ${symbol} order ${orderId}`);
    } catch (err: any) {
      console.warn(`[news] cancel order ${orderId} (${symbol}) failed: ${err.message}`);
    }
  }

  // Drop our own pending markers for this symbol so the duplicate gate doesn't keep
  // treating a now-cancelled order as "pending fill".
  for (const [label, p] of state.pendingOrders.entries()) {
    if (p.symbol === symbol) state.pendingOrders.delete(label);
  }
  return cancelled;
}

// A resting (unfilled) entry order sitting at the broker: a LIMIT or STOP that
// hasn't been reached yet. Shape the Mini App renders and can cancel by orderId.
export interface PendingOrderRow {
  orderId: number;
  symbol: string;
  direction: "BUY" | "SELL";
  orderType: "LIMIT" | "STOP";
  price: number; // the resting level (limit price, or stop trigger)
  volume: number; // lots
  sl: number | null;
  tp: number | null;
  placedAt: number; // epoch ms
  expiresAt: number | null; // epoch ms if GOOD_TILL_DATE, else null (GTC)
}

// Read resting entry orders straight from the broker (the authoritative source:
// state.pendingOrders never stored the broker orderId, and a reconcile also picks
// up orders placed outside the bot). Filtered to allowed symbols, matching how
// positions are adopted. Never throws — returns [] on any failure.
export async function getPendingOrders(): Promise<PendingOrderRow[]> {
  if (!connection) return [];

  let res: any;
  try {
    res = await connection.sendCommand("ProtoOAReconcileReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    });
  } catch (err: any) {
    console.warn(`[PENDING] reconcile failed: ${err.errorCode || err.message || "request failed"}`);
    return [];
  }

  const allowedIds = new Set(
    state.settings.allowedSymbols
      .map((s) => symbolIdFor(s))
      .filter((id): id is number => id !== undefined)
  );

  const rows: PendingOrderRow[] = [];
  for (const o of res.order || []) {
    // Only resting ENTRY orders. Skip MARKET (fills immediately) and the
    // STOP_LOSS_TAKE_PROFIT protective orders that ride an open position.
    if (o.orderType !== "LIMIT" && o.orderType !== "STOP") continue;
    const td = o.tradeData || {};
    const symbolId = Number(td.symbolId);
    if (!allowedIds.has(symbolId)) continue;

    const spec = await getSymbolSpec(symbolId);
    const volumeCents = Number(td.volume) || 0;
    const lots = spec?.lotSize ? volumeCents / spec.lotSize : volumeCents;
    const price = o.orderType === "LIMIT" ? Number(o.limitPrice) || 0 : Number(o.stopPrice) || 0;

    rows.push({
      orderId: Number(o.orderId),
      symbol: symbolNameById(symbolId),
      direction: td.tradeSide === "SELL" ? "SELL" : "BUY",
      orderType: o.orderType,
      price,
      volume: lots,
      sl: o.stopLoss != null ? Number(o.stopLoss) : null,
      tp: o.takeProfit != null ? Number(o.takeProfit) : null,
      placedAt: Number(td.openTimestamp) || 0,
      expiresAt: o.expirationTimestamp ? Number(o.expirationTimestamp) : null,
    });
  }
  return rows;
}

// Cancel a single resting order by its broker orderId. Also drops any in-memory
// pending marker for that order's symbol so the duplicate gate stops treating it
// as an outstanding order.
export async function cancelOrder(orderId: number): Promise<{ ok: boolean; error?: string }> {
  if (!connection) return { ok: false, error: "No broker connection" };
  try {
    await connection.sendCommand("ProtoOACancelOrderReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      orderId,
    });
    console.log(`[PENDING] cancelled resting order ${orderId}`);
    return { ok: true };
  } catch (err: any) {
    console.warn(`[PENDING] cancel order ${orderId} failed: ${err.errorCode || err.message || "request failed"}`);
    return { ok: false, error: err.errorCode || err.message || "cancel failed" };
  }
}

// Decimal places of a price, and rounding to them — the broker silently rejects
// SL/TP with float junk (e.g. 4333.0999999), so levels are rounded to the resting
// level's own precision.
function orderPriceDigits(price: number): number {
  const s = String(price);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}
function roundTo(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

// Amend a resting LIMIT/STOP order: move its level and/or its SL/TP. Reads the
// order fresh from the broker (authoritative type/side/volume), so the caller
// only sends the fields it wants changed; any left null keep their current value.
// Validates SL/TP sit on the correct side of the (new) entry. Success arrives as
// an ORDER_REPLACED execution event, failure as ProtoOAOrderErrorEvent, matching
// the position-amend path. Never clears an existing SL/TP.
export async function amendOrder(
  orderId: number,
  changes: { price?: number | null; sl?: number | null; tp?: number | null }
): Promise<{ ok: boolean; error?: string }> {
  if (!connection) return { ok: false, error: "No broker connection" };

  let res: any;
  try {
    res = await connection.sendCommand("ProtoOAReconcileReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    });
  } catch (err: any) {
    return { ok: false, error: err.errorCode || err.message || "reconcile failed" };
  }

  const o = (res.order || []).find((x: any) => Number(x.orderId) === orderId);
  if (!o) return { ok: false, error: "order not found (it may have filled or been cancelled)" };
  if (o.orderType !== "LIMIT" && o.orderType !== "STOP") return { ok: false, error: "not a resting order" };

  const td = o.tradeData || {};
  const direction: "BUY" | "SELL" = td.tradeSide === "SELL" ? "SELL" : "BUY";
  const isLimit = o.orderType === "LIMIT";
  const curLevel = isLimit ? Number(o.limitPrice) || 0 : Number(o.stopPrice) || 0;

  // null (not provided) means "keep current". Positive values set a new level.
  const entry = changes.price != null && changes.price > 0 ? changes.price : curLevel;
  const sl = changes.sl != null && changes.sl > 0 ? changes.sl : (o.stopLoss != null ? Number(o.stopLoss) : null);
  const tp = changes.tp != null && changes.tp > 0 ? changes.tp : (o.takeProfit != null ? Number(o.takeProfit) : null);

  // Same side rule the order placement and position amend enforce.
  if (direction === "BUY") {
    if (tp != null && tp <= entry) return { ok: false, error: `For a BUY, TP must be above the entry (${entry})` };
    if (sl != null && sl >= entry) return { ok: false, error: `For a BUY, SL must be below the entry (${entry})` };
  } else {
    if (tp != null && tp >= entry) return { ok: false, error: `For a SELL, TP must be below the entry (${entry})` };
    if (sl != null && sl <= entry) return { ok: false, error: `For a SELL, SL must be above the entry (${entry})` };
  }

  const digits = orderPriceDigits(curLevel || entry);
  const fields: Record<string, any> = {
    // Resend the volume and (preserved) expiry: cTrader's amend replaces the
    // order's parameters, so omitting these can reset them.
    volume: Number(td.volume) || 0,
    ...(isLimit ? { limitPrice: roundTo(entry, digits) } : { stopPrice: roundTo(entry, digits) }),
  };
  if (sl != null) fields.stopLoss = roundTo(sl, digits);
  if (tp != null) fields.takeProfit = roundTo(tp, digits);
  if (o.expirationTimestamp) fields.expirationTimestamp = Number(o.expirationTimestamp);

  const msgId = randomUUID();
  const outcome = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      connection.removeEventListener(execId);
      connection.removeEventListener(errId);
    };
    const timer = setTimeout(() => {
      cleanup();
      // No confirmation in time: treat as sent (the amend usually lands); the next
      // reconcile the app polls will reflect the truth either way.
      console.log(`[AMEND-ORDER] #${orderId}: no confirmation within 5s`);
      resolve({ ok: true });
    }, 5_000);

    let execId: string;
    execId = connection.on("ProtoOAExecutionEvent", (event: any) => {
      const data = event.descriptor ?? event;
      if (Number(data.order?.orderId) !== orderId) return;
      if (data.executionType === "ORDER_REPLACED" || data.executionType === 3) {
        cleanup();
        console.log(`[AMEND-ORDER] #${orderId}: confirmed (level ${entry}, SL ${sl ?? "-"}, TP ${tp ?? "-"})`);
        resolve({ ok: true });
      }
    });

    let errId: string;
    errId = connection.on("ProtoOAOrderErrorEvent", (event: any) => {
      const data = event.descriptor ?? event;
      if (data.clientMsgId !== msgId) return;
      cleanup();
      console.log(`[AMEND-ORDER] #${orderId}: REJECTED ${data.errorCode} - ${data.description}`);
      resolve({ ok: false, error: data.errorCode || data.description || "amend rejected" });
    });
  });

  try {
    await connection.sendCommand("ProtoOAAmendOrderReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      orderId,
      ...fields,
    }, msgId);
  } catch (err: any) {
    return { ok: false, error: err.errorCode || err.message || "amend failed" };
  }
  return outcome;
}

interface SymbolSpec {
  lotSize: number;    // cents per 1.0 lot
  minVolume: number;  // cents
  stepVolume: number; // cents
  maxVolume: number;  // cents
}

// Per-symbol contract specs (broker data, not user settings) cached by symbolId.
const symbolSpecs = new Map<number, SymbolSpec>();

export async function getSymbolSpec(symbolId: number): Promise<SymbolSpec | null> {
  const cached = symbolSpecs.get(symbolId);
  if (cached) return cached;

  const res = await connection.sendCommand("ProtoOASymbolByIdReq", {
    ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    symbolId: [symbolId],
  });
  const sym = (res.symbol || [])[0];
  if (!sym) return null;

  const spec: SymbolSpec = {
    lotSize: Number(sym.lotSize) || 0,
    minVolume: Number(sym.minVolume) || 0,
    stepVolume: Number(sym.stepVolume) || 1,
    maxVolume: Number(sym.maxVolume) || 0,
  };
  symbolSpecs.set(symbolId, spec);
  return spec;
}

// Compute the broker volume (cents) so the position loses ~riskUSD if price moves
// stopDistance (the entry-to-SL price distance) against it. The money model is the
// same one floatingPnL uses: $PnL = priceDiff × volumeCents/100, so
// volumeCents = riskUSD × 100 / stopDistance. Snapped to the symbol's min/step/max.
// stopDistance comes from the signal's real SL, so the sizing tracks the actual
// stop the scanner drew rather than a fixed percentage.
function riskBasedVolume(riskUSD: number, stopDistance: number, spec: SymbolSpec): number | null {
  if (!spec.lotSize) return null;
  if (stopDistance <= 0) return null;
  let vol = (riskUSD * 100) / stopDistance;
  if (spec.stepVolume > 0) vol = Math.round(vol / spec.stepVolume) * spec.stepVolume;
  if (spec.minVolume && vol < spec.minVolume) vol = spec.minVolume;
  if (spec.maxVolume && vol > spec.maxVolume) vol = spec.maxVolume;
  return vol > 0 ? vol : null;
}

// ---------------------------------------------------------------------------
// Mini-app order preview
//
// The manual-order panel needs to show, before anything is placed, what a given
// size would risk (or what a given risk implies as a size). Both directions use
// the SAME model and the SAME broker-grid snapping as executeSignal's manual
// path, so the figure on screen is the one the order actually gets — deliberately
// computed here rather than re-derived in the browser, where it would silently
// drift from the money model the moment either changes.

export interface OrderPreviewParams {
  symbol: string;
  direction: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  entry?: number | null;   // resting level; required for LIMIT
  sl?: number | null;
  tp?: number | null;
  mode: "size" | "risk";
  lots?: number | null;    // mode = "size"
  riskUSD?: number | null; // mode = "risk"
}

export interface OrderPreview {
  symbol: string;
  markPrice: number | null;
  entryRef: number | null;   // what the risk/reward is measured from
  lots: number | null;       // final lots, after snapping to the broker grid
  volumeCents: number | null;
  riskUSD: number | null;    // loss if the SL is hit, at the FINAL size
  rewardUSD: number | null;  // gain if the TP is hit, at the FINAL size
  rr: number | null;
  snapped: boolean;          // the broker grid moved the size off what was asked
  minLots: number | null;
  lotStep: number | null;
  warnings: string[];
}

export async function previewOrder(p: OrderPreviewParams): Promise<{ ok: boolean; error?: string; preview?: OrderPreview }> {
  const symbol = String(p.symbol || "").toUpperCase();
  const direction = p.direction === "SELL" ? "SELL" : "BUY";
  const warnings: string[] = [];

  const symId = symbolIdFor(symbol);
  if (symId === undefined) return { ok: false, error: `${symbol} is not available on this broker` };
  if (!canValueInUsd(symbol)) return { ok: false, error: `${symbol} cannot be valued in USD (no conversion pair)` };
  if (!state.settings.allowedSymbols.includes(symbol)) {
    warnings.push(`${symbol} is not in your allowed symbols; the order would be refused.`);
  }

  const spec = await getSymbolSpec(symId);
  if (!spec?.lotSize) return { ok: false, error: `No contract spec for ${symbol}` };

  const markPrice = getMarkPrice(symbol, direction);
  if (markPrice === null) warnings.push("No live quote yet for this symbol.");

  // Same anchor executeSignal uses: an explicit resting level for a limit,
  // otherwise the live mark.
  const entryRef = p.orderType === "LIMIT"
    ? (p.entry && p.entry > 0 ? p.entry : null)
    : markPrice;

  // quoteToUsd is 1 for USD-quoted symbols; a missing rate only degrades this
  // display figure (executeSignal's manual path falls back to 1 the same way).
  const factorRaw = quoteToUsd(symbol);
  if (factorRaw === null) warnings.push("No USD conversion rate yet; figures are approximate.");
  const factor = factorRaw ?? 1;

  const sl = p.sl != null && p.sl > 0 ? p.sl : null;
  const tp = p.tp != null && p.tp > 0 ? p.tp : null;
  const stopDistance = sl != null && entryRef != null ? Math.abs(entryRef - sl) : null;

  // Resolve the size, from either direction of the switch.
  let requestedVol: number | null = null;
  if (p.mode === "risk") {
    const riskUSD = p.riskUSD != null && p.riskUSD > 0 ? p.riskUSD : null;
    if (riskUSD === null) return { ok: false, error: "Enter the amount you are willing to risk" };
    if (stopDistance === null || stopDistance <= 0) {
      return { ok: false, error: entryRef === null ? "No entry price to size against yet" : "Set a stop loss away from the entry to size by risk" };
    }
    // Risk is expressed in the symbol's quote currency for sizing, exactly as
    // executeSignal does (riskUSD / factor), then snapped below.
    requestedVol = (riskUSD / factor) * 100 / stopDistance;
  } else {
    const lots = p.lots != null && p.lots > 0 ? p.lots : null;
    if (lots === null) return { ok: false, error: "Enter a size in lots" };
    requestedVol = lots * spec.lotSize;
  }

  // The broker's volume grid, applied identically to executeSignal's manual path.
  let vol = Math.round(requestedVol);
  if (spec.stepVolume > 0) vol = Math.round(vol / spec.stepVolume) * spec.stepVolume;
  if (spec.minVolume && vol < spec.minVolume) vol = spec.minVolume;
  if (spec.maxVolume && vol > spec.maxVolume) vol = spec.maxVolume;
  if (vol <= 0) return { ok: false, error: "That size rounds to zero on this symbol" };

  // Same test executeSignal's manual path uses: did the grid move the size off
  // what was asked for at all? (A tolerance of half a step would never fire —
  // rounding to the nearest step can't differ by more than that.)
  const snapped = vol !== Math.round(requestedVol);
  const lots = vol / spec.lotSize;

  // Risk/reward at the FINAL (snapped) size, so the number shown is the number
  // that will actually be at stake.
  const riskUSD = stopDistance != null ? stopDistance * (vol / 100) * factor : null;
  const rewardUSD = tp != null && entryRef != null ? Math.abs(tp - entryRef) * (vol / 100) * factor : null;
  const rr = riskUSD && riskUSD > 0 && rewardUSD != null ? rewardUSD / riskUSD : null;

  if (p.mode === "risk" && riskUSD != null && p.riskUSD != null && riskUSD > p.riskUSD * 1.05) {
    warnings.push(`The broker's minimum size risks $${riskUSD.toFixed(2)}, above your $${p.riskUSD.toFixed(2)} target.`);
  }
  if (sl === null) warnings.push("No stop loss set: risk is unbounded.");

  return {
    ok: true,
    preview: {
      symbol,
      markPrice,
      entryRef,
      lots,
      volumeCents: vol,
      riskUSD,
      rewardUSD,
      rr,
      snapped,
      minLots: spec.minVolume ? spec.minVolume / spec.lotSize : null,
      lotStep: spec.stepVolume ? spec.stepVolume / spec.lotSize : null,
      warnings,
    },
  };
}

// Trading costs booked on a freshly filled position, read straight off the
// execution event. Money fields are integers scaled by moneyDigits (commission
// "-608" with moneyDigits 2 = -$6.08). Reconcile fills these in for positions
// that predate the session; this covers the ones opened while we're running,
// which reconcile (boot/reconnect only) would otherwise leave blank.
function dealCosts(deal: any, pos: any): { commission: number; swap: number } {
  const div = Math.pow(10, Number(deal?.moneyDigits ?? pos?.moneyDigits ?? 2));
  return {
    commission: Number(deal?.commission ?? 0) / div,
    swap: Number(pos?.swap ?? 0) / div,
  };
}

// Reverse lookup of a symbolId to its name using the cached symbolMap.
function symbolNameById(symbolId: number): string {
  const target = String(symbolId);
  for (const [name, id] of state.symbolMap.entries()) {
    if (String(id) === target) return name;
  }
  return `#${symbolId}`;
}

// On startup, pull the broker's actual open positions into state.positions.
// state.positions is in-memory only, so without this a restart would forget
// open positions — leaving the midnight closer and max-positions gate blind to
// anything opened before the restart.
export async function reconcilePositions(): Promise<void> {
  if (!connection) return;

  // Reconcile is a nice-to-have (repopulates positions opened before a restart).
  // Some accounts/servers reject it (CANT_ROUTE_REQUEST), so never let a failure
  // here crash boot — log and continue.
  try {
    const res = await connection.sendCommand("ProtoOAReconcileReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    });
    const positions = res.position || [];
    // Diagnostic: how many positions the broker actually returned, before our
    // status filter. If this is 0 while positions are open in cTrader, the
    // reconcile request itself is coming back empty (account/host routing).
    console.log(`[RECONCILE] Broker returned ${positions.length} raw position(s).`);

    // Only adopt positions on symbols the bot is configured to trade. The same
    // account is also traded manually (e.g. FX pairs), and our floating-P&L money
    // model assumes a USD quote currency — applying it to a JPY/CAD-quoted pair
    // overstates its P&L by ~the cross rate, which once produced a false daily-loss
    // breach that force-closed a manual trade. allowedSymbols are all USD-quoted,
    // so restricting here keeps every tracked position correctly valued. Resolved
    // via symbolIdFor so the broker's symbol naming is matched, not the raw string.
    const allowedIds = new Set(
      state.settings.allowedSymbols
        .map((s) => symbolIdFor(s))
        .filter((id): id is number => id !== undefined)
    );

    let count = 0;
    for (const p of positions) {
      if (p.positionStatus && p.positionStatus !== "POSITION_STATUS_OPEN" && p.positionStatus !== 1) continue;
      const td = p.tradeData || {};
      const symbolId = Number(td.symbolId);
      if (!allowedIds.has(symbolId)) {
        console.log(`[RECONCILE] Skipping position #${p.positionId} on ${symbolNameById(symbolId)} — not an allowed bot symbol (manual trade).`);
        continue;
      }
      // Only adopt positions we can value in USD: USD-quoted directly, or non-USD
      // (JPY/CAD) with a conversion pair. Use the convertibility test (not the live
      // rate) so a position is still adopted when its conversion rate hasn't streamed
      // yet at boot; floatingPnL converts it once the rate warms.
      if (!canValueInUsd(symbolNameById(symbolId))) {
        console.log(`[RECONCILE] Skipping position #${p.positionId} on ${symbolNameById(symbolId)} — cannot be valued in USD (no conversion pair).`);
        continue;
      }
      const volumeCents = Number(td.volume) || 0;

      let lots = 0;
      const spec = await getSymbolSpec(symbolId);
      if (spec?.lotSize) lots = volumeCents / spec.lotSize;

      const entry = Number(p.price) || 0;
      const direction: "BUY" | "SELL" = td.tradeSide === "SELL" ? "SELL" : "BUY";
      // Seed the trend price history with the broker's current mark price so
      // floatingPnL() has a value immediately after restart.
      const symName = symbolNameById(symbolId);
      // Costs are integers scaled by the position's own moneyDigits (e.g.
      // commission "-608" with moneyDigits 2 = -$6.08).
      const costDiv = Math.pow(10, Number(p.moneyDigits ?? 2));
      const posSlot = {
        symbol: symName,
        direction,
        volume: lots,
        volumeCents,
        entryPrice: entry,
        openTime: Number(td.openTimestamp) || Date.now(),
        commission: Number(p.commission || 0) / costDiv,
        swap: Number(p.swap || 0) / costDiv,
        sl: p.stopLoss ?? null,
        tp: p.takeProfit ?? null,
      };
      const pid = Number(p.positionId);
      state.positions.set(pid, posSlot);

      // The broker echoes the position's live SL/TP above (p.stopLoss/p.takeProfit),
      // so a reconciled position keeps whatever protection it already had. We can't
      // re-derive a missing TP anymore — the signal's own level isn't recoverable
      // after a restart — so we leave it as-is (the SL and daily-loss limit still
      // cap the downside). The rare gap: a market fill restarted mid-minhold before
      // its TP was sent has SL only until manually managed.

      count++;
    }

    console.log(`[RECONCILE] Loaded ${count} open position(s) from broker. Tracking ${state.positions.size}.`);
  } catch (err: any) {
    console.warn(`[RECONCILE] Skipped — ${err.errorCode || err.message || "request failed"}. Bot will track only positions it opens this session.`);
  }
}

// Fraction of equity that may be committed as margin across all positions,
// split equally across maxPositions slots. Keeps every position affordable so up
// to maxPositions can be held at once, with a buffer left for adverse moves.
const MARGIN_CAP_FRACTION = 0.8;

// Ask the broker how much margin a volume needs on a symbol. This is the only
// figure that captures the symbol's leverage (gold needs ~1% of notional, alts
// can need ~40%), which risk-based sizing is blind to. Returns the amount in the
// deposit currency, or null if unavailable (caller then keeps the risk size).
async function getExpectedMargin(symbolId: number, volumeCents: number, direction: "BUY" | "SELL"): Promise<number | null> {
  try {
    const res = await connection.sendCommand("ProtoOAExpectedMarginReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      symbolId,
      volume: [volumeCents],
    });
    const m = (res.margin || [])[0];
    if (!m) return null;
    // int64 fields decode as strings; money is scaled by moneyDigits.
    const div = Math.pow(10, Number(res.moneyDigits ?? 2));
    const margin = Number(direction === "BUY" ? m.buyMargin : m.sellMargin) / div;
    return margin > 0 ? margin : null;
  } catch (err: any) {
    console.log(`[MARGIN] Expected-margin query failed for symbol ${symbolId}: ${err.errorCode || err.message || "request failed"}`);
    return null;
  }
}

// Outcome of placing an order. Feed/channel callers ignore it (fire-and-forget);
// manual Telegram orders use it to reply to the user with success or the reason.
export interface OrderResult {
  ok: boolean;
  error?: string;
}

export async function executeSignal(signal: ParsedSignal): Promise<OrderResult> {
  if (!connection) {
    console.log("[ORDER] No cTrader connection");
    return { ok: false, error: "No broker connection" };
  }

  console.log("[ORDER] executeSignal called for", signal.symbol);
  const symbolId = symbolIdFor(signal.symbol);
  if (!symbolId) {
    console.log(`[ORDER] Symbol not found in cache: ${signal.symbol}`);
    return { ok: false, error: `Symbol ${signal.symbol} not available on this broker` };
  }
  console.log(`[ORDER] Resolved ${signal.symbol} → symbolId ${symbolId}`);

  // Belt-and-braces scheduled-news blackout. The gate (processSignal) is the
  // primary block and runs before the reversal path, so an in-scope gold signal
  // never reaches here during a blackout via the normal flow. This guards any
  // OTHER caller that reaches executeSignal directly (matches the SL belt-and-
  // braces below) so an in-scope entry can't slip through the news window.
  const blackout = inEntryBlackout(Date.now(), signal.symbol, signal.signalSource);
  if (blackout.blocked) {
    console.log(`[news] blocked ${signal.symbol} ${signal.direction} entry (order path) - ${blackout.reason}`);
    return { ok: false, error: `News blackout: ${blackout.reason}` };
  }

  // Effective per-signal time-based exit (minutes from fill), scoped to the
  // configured symbols/sources and clamped to maxTimeExitMin. 0 for everything else
  // (all existing sources omit time_exit_min, so they are unaffected). Recorded on
  // the position at fill (below) and enforced by the time-exit monitor; a resting
  // order for a timed signal is also given a matching expiry so it can't fill past
  // the hold window.
  const timeExitMin = effectiveTimeExitMin(signal.symbol, signal.signalSource, signal.timeExitMin);

  // Size the order using the symbol's real contract specs. A hardcoded
  // multiplier produces wildly wrong volumes for non-FX symbols (e.g. BTC),
  // which the broker rejects as NOT_ENOUGH_MONEY.
  const spec = await getSymbolSpec(symbolId);
  if (!spec) {
    console.log(`[ORDER] No contract spec for ${signal.symbol}; skipping`);
    return { ok: false, error: `No contract spec for ${signal.symbol}` };
  }

  // Sizing has two sources:
  //  - Manual order (signal.manualLots set): the exact lot size the user typed in
  //    Telegram. Used verbatim, snapped only to the broker's volume grid. No risk
  //    sizing and no margin cap — they asked for this size.
  //  - Feed/channel signal: risk-based — derive the volume so the signal's own
  //    entry-to-SL distance loses ~riskPerTradeUSD. There is no fixed-lot mode for
  //    these; if risk sizing isn't configured, or the signal carries no SL, we
  //    refuse to trade rather than guess a size (an unsized order is how the -$350
  //    happened).
  let orderVolume: number;
  let actualRisk: number;
  let price: number | null;

  if (signal.manualLots != null) {
    if (!spec.lotSize) {
      console.log(`[ORDER] No lotSize for ${signal.symbol}; cannot size manual order`);
      return { ok: false, error: `Cannot size ${signal.symbol} (no lot size from broker)` };
    }
    // Lots → broker volume (cents), snapped to the symbol's step/min/max so an
    // off-grid size isn't rejected outright.
    let vol = Math.round(signal.manualLots * spec.lotSize);
    if (spec.stepVolume > 0) vol = Math.round(vol / spec.stepVolume) * spec.stepVolume;
    if (spec.minVolume && vol < spec.minVolume) vol = spec.minVolume;
    if (spec.maxVolume && vol > spec.maxVolume) vol = spec.maxVolume;
    orderVolume = vol;
    // Best-effort reference price for the risk estimate / diagnostic only.
    price = getMarkPrice(signal.symbol, signal.direction)
      ?? (signal.limitPrice && signal.limitPrice > 0 ? signal.limitPrice : null)
      ?? (signal.price && signal.price > 0 ? signal.price : null);
    const entryRef = signal.limitPrice && signal.limitPrice > 0 ? signal.limitPrice : (price ?? 0);
    // Convert the quote-currency risk to USD for the estimate (1 for USD-quoted).
    // Manual orders are user-sized, so a missing rate only degrades this display
    // figure (falls back to 1) — it never blocks the order.
    const manualFactor = quoteToUsd(signal.symbol) ?? 1;
    actualRisk = signal.sl != null && entryRef > 0
      ? Math.abs(entryRef - signal.sl) * (orderVolume / 100) * manualFactor
      : 0;
    const snapped = orderVolume !== Math.round(signal.manualLots * spec.lotSize);
    console.log(`[ORDER] Manual ${signal.symbol}: ${signal.manualLots} lots -> ${orderVolume} vol${snapped ? " (snapped to broker grid)" : ""} (~$${actualRisk.toFixed(2)} risk)`);
  } else {
    const riskUSD = state.settings.riskPerTradeUSD ?? 0;
    if (riskUSD <= 0) {
      console.log(`[ORDER] Risk sizing not configured (pertrade=$${riskUSD}) — skipping ${signal.symbol}. Set /risk pertrade.`);
      return { ok: false, error: "Risk sizing not configured (set /risk pertrade)" };
    }
    // Belt-and-braces: the gate rejects feed/channel signals with no SL, but the
    // reversal path (and any future caller) reaches here too — never size without a
    // stop, that is exactly how an unsized/over-risked order slips through.
    if (signal.sl == null) {
      console.log(`[ORDER] ${signal.symbol}: signal carries no SL — cannot size to a stop, skipping`);
      return { ok: false, error: `No SL on ${signal.symbol} signal` };
    }

    // Entry anchor the stop distance is measured from: an explicit resting level if
    // the signal already carries one (channel/manual limit), otherwise the feed's
    // target price, and finally the live mark (channel market orders carry no price
    // of their own). This is where the fill lands (or within tolerance of it), so
    // |anchor − SL| is the real price distance the position risks to its stop.
    const entryAnchor =
      (signal.limitPrice && signal.limitPrice > 0) ? signal.limitPrice
      : (signal.stopPrice && signal.stopPrice > 0) ? signal.stopPrice
      : (signal.price && signal.price > 0) ? signal.price
      : getMarkPrice(signal.symbol, signal.direction) ?? null;
    if (!entryAnchor || entryAnchor <= 0) {
      console.log(`[ORDER] No price for ${signal.symbol} (no live quote, signal carries none) — skipping to avoid an unsized order`);
      return { ok: false, error: `No price for ${signal.symbol} yet` };
    }
    price = entryAnchor;

    const stopDistance = Math.abs(entryAnchor - signal.sl);
    if (stopDistance <= 0) {
      console.log(`[ORDER] ${signal.symbol}: SL ${signal.sl} equals entry ${entryAnchor} — zero stop distance, skipping`);
      return { ok: false, error: `SL equals entry for ${signal.symbol}` };
    }

    // Quote-currency-to-USD factor for this symbol (1 for USD-quoted; the live
    // conversion-pair rate for JPY/CAD-quoted). Refuse the trade outright if no rate
    // is available even from the cache: a non-USD position sized without it would be
    // mis-sized by ~the cross rate. This is the rare-case guard the boot pre-subscribe
    // is meant to keep from ever firing.
    const factor = quoteToUsd(signal.symbol);
    if (factor === null) {
      console.log(`[ORDER] ${signal.symbol}: no USD conversion rate available yet — refusing to size (avoids a mis-sized non-USD order)`);
      if (state.settings.notifyFills) {
        notify(`Skipped ${signal.direction} ${signal.symbol}: no USD conversion rate yet for its quote currency. It will trade once the rate streams.`);
      }
      return { ok: false, error: `No USD conversion rate for ${signal.symbol} yet` };
    }

    // stopDistance is a price distance in the symbol's QUOTE currency, so size
    // against the per-trade target expressed in that same currency: riskUSD / factor
    // (identical to riskUSD when factor is 1 for USD-quoted symbols).
    const riskQuote = riskUSD / factor;
    const sized = riskBasedVolume(riskQuote, stopDistance, spec);
    if (!sized) {
      console.log(`[ORDER] Could not compute volume for ${signal.symbol} (lotSize ${spec.lotSize}); skipping`);
      return { ok: false, error: `Could not size ${signal.symbol}` };
    }
    orderVolume = sized;

    // Margin-aware cap (toggled by /risk marginaware). Risk-based sizing bounds the
    // dollar risk at the stop but ignores margin, so a tight stop on a low-leverage
    // symbol (alts) can need far more margin than the account can post, which the
    // broker rejects as NOT_ENOUGH_MONEY. When enabled, cap each position to an
    // equal share of equity so up to maxPositions positions always fit. When
    // disabled, place the full risk-based size (and skip the extra broker calls).
    // Fail-safe: if the margin figure is unavailable we keep the risk-based size.
    if (state.settings.marginAware) {
      const expMargin = await getExpectedMargin(symbolId, orderVolume, signal.direction);
      if (expMargin !== null) {
        let balance = state.accountInfo.balance;
        try { balance = (await fetchTrader(connection)).balance; } catch { /* keep cached balance */ }
        const equity = balance + floatingPnL();
        const budget = (equity * MARGIN_CAP_FRACTION) / Math.max(1, state.settings.maxPositions);
        if (expMargin > budget) {
          const step = spec.stepVolume || 1;
          const scaled = Math.floor((orderVolume * budget) / expMargin / step) * step;
          if (!scaled || (spec.minVolume && scaled < spec.minVolume)) {
            console.log(`[MARGIN] ${signal.direction} ${signal.symbol}: needs ~$${expMargin.toFixed(2)} margin but per-trade budget is ~$${budget.toFixed(2)} (equity ~$${equity.toFixed(2)} / ${state.settings.maxPositions}); even the minimum size will not fit, skipping`);
            if (state.settings.notifyFills) {
              notify(`Skipped ${signal.direction} ${signal.symbol}: needs ~$${expMargin.toFixed(2)} margin, only ~$${budget.toFixed(2)} budget per trade. Lower /risk pertrade or reduce /risk maxpos.`);
            }
            return { ok: false, error: `Not enough margin for ${signal.symbol}` };
          }
          console.log(`[MARGIN] ${signal.direction} ${signal.symbol}: margin-capped ${orderVolume} -> ${scaled} vol (needs ~$${expMargin.toFixed(2)} > budget ~$${budget.toFixed(2)}, equity ~$${equity.toFixed(2)})`);
          orderVolume = scaled;
        }
      }
    }

    // Report the ACTUAL risk of the final (possibly margin-capped) size in USD,
    // measured against the real stop distance and converted from quote currency.
    actualRisk = stopDistance * (orderVolume / 100) * factor;
    console.log(`[ORDER] Risk-sized ${signal.symbol}: ${orderVolume} vol -> ~$${actualRisk.toFixed(2)} at stop ${stopDistance} from ${entryAnchor} (target $${riskUSD})`);

    // Overrun guard: a wide stop makes the risk-based size small, and the broker's
    // minimum volume can floor it above what riskPerTradeUSD allows. On a loss-
    // limited (prop) account, silently risking well over the per-trade cap is worse
    // than skipping, but a small overshoot from the min-lot floor is usually fine —
    // so the tolerance is configurable via /risk overrun (% over target). (The
    // margin cap only ever lowers the size, so it never trips this.)
    const overrunPct = state.settings.riskOverrunPercent ?? 0;
    const overrunLimit = riskUSD * (1 + overrunPct / 100);
    if (actualRisk > overrunLimit) {
      console.log(`[ORDER] ${signal.symbol}: broker min volume forces risk to ~$${actualRisk.toFixed(2)}, over the $${riskUSD} per-trade cap +${overrunPct}% (=$${overrunLimit.toFixed(2)}) — rejecting`);
      if (state.settings.notifyFills) {
        notify(`Skipped ${signal.direction} ${signal.symbol}: its stop is wide enough that the smallest tradable size risks ~$${actualRisk.toFixed(2)}, over your $${riskUSD} per-trade limit +${overrunPct}%. Raise /risk pertrade or /risk overrun to take it.`);
      }
      return { ok: false, error: `Risk ~$${actualRisk.toFixed(2)} exceeds per-trade cap $${riskUSD} +${overrunPct}%` };
    }
  }

  // Display lots derived from the final broker volume, so logs and the stored
  // position reflect the size actually sent regardless of sizing mode.
  const lots = spec.lotSize ? orderVolume / spec.lotSize : 0;

  // DIAGNOSTIC (NOT_ENOUGH_MONEY investigation): log the margin this single order
  // needs vs the account, to confirm whether one order already exceeds free
  // margin and what the effective leverage is. Runs regardless of the
  // margin-aware toggle. Remove once the cause is confirmed.
  try {
    const dm = await getExpectedMargin(symbolId, orderVolume, signal.direction);
    const notional = (price ?? 0) * (orderVolume / 100);
    const lev = dm && dm > 0 ? (notional / dm).toFixed(1) : "?";
    console.log(`[MARGIN-DIAG] ${signal.direction} ${signal.symbol}: needs ~$${dm !== null ? dm.toFixed(2) : "?"} margin, notional ~$${notional.toFixed(0)} (effective leverage ~1:${lev}), balance $${state.accountInfo.balance.toFixed(2)}, open positions ${state.positions.size}`);
  } catch { /* diagnostic only, never block the order */ }

  // Unique label per order so we can correlate execution events back to THIS
  // order. Without it, concurrent orders' listeners all match any ORDER_FILLED
  // event and mis-attribute fills (double/wrong SL, missed positions).
  const label = randomUUID();

  // Register as pending the instant we're about to submit, so the duplicate gate
  // sees an outstanding order for this symbol+direction before any fill arrives.
  // cleanup() (fill/timeout/reject) and the catch below all clear it again.
  state.pendingOrders.set(label, {
    symbol: signal.symbol,
    direction: signal.direction,
    placedAt: Date.now(),
  });

  // Execution-type decision for FEED signals (no explicit orderType, not a manual
  // order). signal.price is the TARGET the market must reach; we rest an order there
  // and fill only when price actually arrives - if it never does, no trade. We own
  // the choice here, at execution time, using our OWN live mark, and the order TYPE
  // is simply whichever the exchange requires for that side of the market:
  //   target within tolerance of live -> MARKET (already at the level; also a
  //                                      resting order at the current price can be
  //                                      rejected).
  //   target the market must RISE to  -> BUY: buy-STOP  | SELL: sell-LIMIT
  //     (price > live)
  //   target the market must FALL to  -> BUY: buy-LIMIT | SELL: sell-STOP
  //     (price < live)
  // Both non-market legs rest at signal.price and are non-marketable, so the fill
  // lands at ~price and %SL/TP anchored to it stay on the correct side (SL below for
  // BUY / above for SELL) - no wrong-side-of-level bug in any path. No live quote or
  // tolerance 0 -> MARKET. Manual (/order) and channel signals set their own type.
  // Staleness window (ms) for a feed resting order: cancel it if unfilled after
  // staleOrderBars bars of the signal's timeframe. Set only when this signal is
  // promoted to a resting order below; stays 0 for market fills and for
  // channel/manual entries (which keep their good-till-cancel behaviour).
  let restStaleMs = 0;
  if (!signal.orderType && signal.manualLots == null && signal.price > 0) {
    const tolPct = ENTRY_TOLERANCE_PERCENT;
    const live = getMarkPrice(signal.symbol, signal.direction);
    if (tolPct > 0 && live && live > 0) {
      const driftPct = (Math.abs(live - signal.price) / signal.price) * 100;
      if (driftPct <= tolPct) {
        console.log(`[ORDER] ${signal.symbol}: live ${live} within ${tolPct}% of target ${signal.price} (${driftPct.toFixed(2)}%) - MARKET`);
      } else {
        // A target the market must rise to is a buy-STOP (long) or sell-LIMIT
        // (short); one it must fall to is a buy-LIMIT (long) or sell-STOP (short).
        const mustRise = signal.price > live;
        const kind: "STOP" | "LIMIT" =
          signal.direction === "BUY" ? (mustRise ? "STOP" : "LIMIT")
                                     : (mustRise ? "LIMIT" : "STOP");
        signal.orderType = kind;
        if (kind === "STOP") signal.stopPrice = signal.price;
        else signal.limitPrice = signal.price;
        // The resting order carries the signal's own SL/TP (already on the signal,
        // anchored to signal.price = the resting level). The order fills at ~price,
        // so they stay on the correct side; placeRestingOrder attaches them verbatim.
        // Staleness guard: give the setup up to staleOrderBars bars of its own
        // timeframe to be reached, then cancel the unfilled order (a target the
        // market never came back to is a stale idea). Skipped (GTC) when the bars
        // setting is 0 or the timeframe can't be parsed.
        const bars = state.settings.staleOrderBars;
        const barMs = timeframeMs(signal.timeframe);
        if (bars > 0 && barMs) restStaleMs = bars * barMs;
        // Time-exit signals: don't enter a position that's already past its hold
        // window. Cap the resting order's expiry at time_exit_min from placement so
        // an unfilled order is cancelled by then (the broker enforces it via
        // GOOD_TILL_DATE, surviving a restart). Whichever expiry is shorter wins.
        restStaleMs = restingExpiryMs(restStaleMs, timeExitMin);
        console.log(`[ORDER] ${signal.symbol}: live ${live} is ${driftPct.toFixed(2)}% from target ${signal.price} (> ${tolPct}% tol) - resting ${signal.direction}-${kind} @ ${signal.price} (SL ${signal.sl ?? "-"} / TP ${signal.tp ?? "-"})${restStaleMs > 0 ? ` [cancel in ${Math.round(restStaleMs / 60_000)}m if unfilled]` : ""}`);
      }
    }
  }

  // Resting orders (channel/manual LIMIT entries, and feed STOP breakouts promoted
  // just above) sit at the broker until price reaches the level, rather than filling
  // immediately like a market order. They carry their SL/TP on the order itself so
  // the resting order is self-contained (protected even across a bot restart).
  // Handled by placeRestingOrder, separate from the immediate market fill path
  // below; sizing/volume above is shared.
  if (signal.orderType === "LIMIT" && signal.limitPrice && signal.limitPrice > 0) {
    return await placeRestingOrder(signal, symbolId, orderVolume, lots, label, "LIMIT", restStaleMs, timeExitMin);
  }
  if (signal.orderType === "STOP" && signal.stopPrice && signal.stopPrice > 0) {
    return await placeRestingOrder(signal, symbolId, orderVolume, lots, label, "STOP", restStaleMs, timeExitMin);
  }

  try {
    console.log(`[ORDER] Placing ${signal.direction} ${lots} lots (${orderVolume} vol) ${signal.symbol} (label ${label.slice(0, 8)})...`);

    const fillPromise = new Promise<void>((resolve, reject) => {
      let ourOrderId: number | null = null;

      const cleanup = () => {
        clearTimeout(timeout);
        connection.removeEventListener(listenerId);
        connection.removeEventListener(errorListenerId);
        state.pendingOrders.delete(label);
      };

      const timeout = setTimeout(async () => {
        cleanup();
        // The order is still unfilled but remains LIVE at the broker — it can
        // fill later, unattended. Cancel it before abandoning the attempt.
        if (ourOrderId !== null) {
          try {
            await connection.sendCommand("ProtoOACancelOrderReq", {
              ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
              orderId: ourOrderId,
            });
            console.log(`[ORDER] Timed out — cancelled unfilled order ${ourOrderId} (${signal.symbol})`);
          } catch (e: any) {
            console.log(`[ORDER] Timed out — cancel request FAILED for order ${ourOrderId} (${signal.symbol}): ${e.message}`);
          }
        } else {
          // No ORDER_ACCEPTED ever arrived — the broker never acknowledged the
          // order, so it was almost certainly REJECTED outright. cTrader sends
          // that rejection as a generic PROTO_OA_ERROR_RES (payload 2142), which
          // the ctrader-layer can't route and just logs as "Unknown payload type
          // 2142" — that line above this is the real cause. Common reasons:
          // ACCESS_TOKEN lacks the "trading" scope, CTRADER_HOST (demo/live)
          // doesn't match the account, or a wrong ACCOUNT_ID.
          console.log(`[ORDER] No broker acknowledgement for ${signal.symbol} — order was likely REJECTED (see any "Unknown payload type 2142" / PROTO_OA_ERROR_RES above). Check: ACCESS_TOKEN has "trading" scope, CTRADER_HOST matches the account (demo vs live), and ACCOUNT_ID is correct.`);
        }
        reject(new Error("Order fill timeout (30s)"));
      }, 30_000);

      // Order rejections (market closed, bad volume, trading disabled) arrive
      // as ProtoOAOrderErrorEvent, NOT ProtoOAExecutionEvent. It carries no
      // label, so correlate by the orderId we learn from our ACCEPTED event.
      let errorListenerId: string;
      errorListenerId = connection.on("ProtoOAOrderErrorEvent", (event: any) => {
        const data = event.descriptor ?? event;
        if (ourOrderId !== null && data.orderId !== ourOrderId) return;
        console.log(`[ORDER] OrderError for ${signal.symbol}:`, JSON.stringify(data));
        cleanup();
        reject(new Error(`Order rejected: ${data.errorCode || "unknown"} ${data.description || ""}`));
      });

      let listenerId: string;
      listenerId = connection.on("ProtoOAExecutionEvent", (event: any) => {
        const data = event.descriptor ?? event;
        // Only handle events for OUR order, matched by label.
        if (data.order?.tradeData?.label !== label) return;

        if (data.order?.orderId) ourOrderId = data.order.orderId;
        console.log(`[ORDER] Execution event (${signal.symbol}): type=${data.executionType} positionId=${data.position?.positionId}`);

        if (data.executionType === "ORDER_FILLED" && data.position?.positionId) {
          cleanup();
          const pos = data.position;
          const deal = data.deal;
          const positionId = Number(pos.positionId);
          const entryPrice = deal?.executionPrice || pos.price || 0;
          const fillTime = Date.now();

          state.positions.set(positionId, {
            symbol: signal.symbol,
            direction: signal.direction,
            volume: lots,
            volumeCents: orderVolume,
            entryPrice,
            openTime: fillTime,
            confidence: signal.confidence,
            source: signal.source,
            ...dealCosts(deal, pos),
            timeExitMin: timeExitMin > 0 ? timeExitMin : null,
          });
          // Arm the time-based exit (persisted so it survives a restart). No-op when
          // timeExitMin is 0, so non-timed signals are unaffected.
          recordTimedPosition(positionId, signal.symbol, timeExitMin, fillTime);

          console.log(`[ORDER] Filled: ${signal.direction} ${lots} lots ${signal.symbol} @ ${entryPrice} | Position #${positionId}`);
          notifyFill("Order filled", signal, lots, entryPrice, positionId, actualRisk);
          // Stream live prices for this symbol so floating P&L / cap stay accurate.
          subscribeSpots([symbolId]);
          amendPositionSLTP(positionId, signal.symbol, entryPrice, signal.direction, {
            sl: signal.sl,
            tp: signal.tp,
          });
          resolve();
        }
      });
    });

    await connection.sendCommand("ProtoOANewOrderReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      symbolId,
      orderType: "MARKET",
      tradeSide: signal.direction,
      volume: orderVolume,
      timeInForce: "IMMEDIATE_OR_CANCEL",
      label,
    });

    await fillPromise;
    return { ok: true };
  } catch (err: any) {
    // Belt-and-braces: cleanup() clears the entry on the normal fill/timeout/
    // reject paths, but if sendCommand itself threw before any listener fired,
    // clear it here so a failed submission never blocks future signals.
    state.pendingOrders.delete(label);
    console.log(`[ORDER] Failed: ${signal.direction} ${signal.symbol} — ${err.message}`);
    return { ok: false, error: err.message || "order failed" };
  }
}

/**
 * Place a resting order at the broker: a LIMIT (channel/manual entries, fills at
 * the level or better) or a STOP (feed breakout entries, triggers only when price
 * reaches the level in the trade's direction). Unlike a market order it does not
 * fill immediately — it sits at the broker (GOOD_TILL_CANCEL) until price reaches
 * the level, which may be seconds or hours. SL/TP are attached to the order, so
 * the resting order is protected even if the bot restarts before it fills. We wait
 * only long enough for the broker to ACCEPT the order (confirming it is resting, or
 * catching an outright rejection) and then return, leaving a listener to record the
 * position whenever the fill eventually arrives.
 *
 * A STOP is sent as a stop-market: it guarantees the fill once triggered, at
 * ~stopPrice (small slippage possible). Switch to STOP_LIMIT here if bounding
 * slippage ever matters more than guaranteeing the fill.
 *
 * staleMs > 0 makes the order GOOD_TILL_DATE, expiring that many ms out (the
 * feed staleness guard: N bars of the signal's timeframe). The broker enforces
 * the expiry, so it holds even across a bot restart; we just clean up our own
 * bookkeeping when the expiry (ORDER_EXPIRED/CANCELLED) event arrives. staleMs 0
 * leaves it GOOD_TILL_CANCEL (channel/manual entries, no auto-expiry).
 *
 * Sizing/volume is computed by the caller (executeSignal) and shared with the
 * market path; only the order-send and fill-handling differ here.
 */
async function placeRestingOrder(
  signal: ParsedSignal,
  symbolId: number,
  orderVolume: number,
  lots: number,
  label: string,
  kind: "LIMIT" | "STOP",
  staleMs: number,
  timeExitMin: number = 0
): Promise<OrderResult> {
  if (!connection) {
    console.log("[ORDER] No cTrader connection");
    state.pendingOrders.delete(label);
    return { ok: false, error: "No broker connection" };
  }

  // The resting level: the limit price for a LIMIT, the trigger price for a STOP.
  // SL/TP sit on the same side of it in both cases (SL below for BUY / above for
  // SELL), so the validation below is identical for the two order types.
  const entry = kind === "STOP" ? signal.stopPrice! : signal.limitPrice!;
  const tag = kind === "STOP" ? "Stop" : "Limit"; // log/notification label
  // Drop SL or TP if it sits on the wrong side of the entry level; the broker
  // would reject the whole order otherwise. (Channel LIMIT levels come verbatim
  // from the message; feed levels are the scanner's own, set upstream.)
  let sl: number | null = signal.sl ?? null;
  let tp: number | null = signal.tp ?? null;
  if (sl !== null && ((signal.direction === "BUY" && sl >= entry) || (signal.direction === "SELL" && sl <= entry))) {
    console.log(`[ORDER] Invalid SL ${sl} for ${signal.direction} ${kind} @ ${entry}; dropping SL`);
    sl = null;
  }
  if (tp !== null && ((signal.direction === "BUY" && tp <= entry) || (signal.direction === "SELL" && tp >= entry))) {
    console.log(`[ORDER] Invalid TP ${tp} for ${signal.direction} ${kind} @ ${entry}; dropping TP`);
    tp = null;
  }

  // Actual dollar risk of this order: the stop distance (entry to SL) times the
  // volume, converted from quote currency to USD (1 for USD-quoted), for the fill
  // notification. 0 if the SL was dropped as wrong-side above.
  const restRisk = (sl !== null ? Math.abs(entry - sl) : 0) * (orderVolume / 100) * (quoteToUsd(signal.symbol) ?? 1);

  let fillListenerId = "";
  let errorListenerId = "";
  let settled = false; // placement phase resolved (accepted/filled) or failed

  const placement = new Promise<void>((resolve, reject) => {
    // If the broker never acknowledges, the order was almost certainly rejected
    // (same PROTO_OA_ERROR_RES / "Unknown payload type 2142" case as market
    // orders). Give up the placement wait — but never auto-cancel a resting
    // order just because it hasn't filled; that's the whole point of a resting order.
    const placeTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.removeEventListener(fillListenerId);
      connection.removeEventListener(errorListenerId);
      state.pendingOrders.delete(label);
      reject(new Error(`No broker acknowledgement for ${kind} order (likely rejected)`));
    }, 10_000);

    errorListenerId = connection.on("ProtoOAOrderErrorEvent", (event: any) => {
      const data = event.descriptor ?? event;
      console.log(`[ORDER] ${tag} OrderError for ${signal.symbol}:`, JSON.stringify(data));
      if (settled) return;
      settled = true;
      clearTimeout(placeTimeout);
      connection.removeEventListener(fillListenerId);
      connection.removeEventListener(errorListenerId);
      state.pendingOrders.delete(label);
      reject(new Error(`Order rejected: ${data.errorCode || "unknown"} ${data.description || ""}`));
    });

    fillListenerId = connection.on("ProtoOAExecutionEvent", (event: any) => {
      const data = event.descriptor ?? event;
      if (data.order?.tradeData?.label !== label) return;
      console.log(`[ORDER] ${tag} execution event (${signal.symbol}): type=${data.executionType} positionId=${data.position?.positionId}`);

      if (data.executionType === "ORDER_ACCEPTED" && !settled) {
        // The order is now resting at the broker. End the placement wait but keep
        // the fill listener registered for the (later) fill.
        settled = true;
        clearTimeout(placeTimeout);
        connection.removeEventListener(errorListenerId);
        const expiryNote = staleMs > 0 ? `, expires in ${Math.round(staleMs / 60_000)}m if unfilled` : "";
        console.log(`[ORDER] ${tag} resting: ${signal.direction} ${lots} lots ${signal.symbol} @ ${entry} (SL ${sl ?? "—"} / TP ${tp ?? "—"}${expiryNote})`);
        resolve();
        return;
      }

      // Broker expired (GOOD_TILL_DATE staleness guard) or cancelled the resting
      // order before it filled. Terminal: drop our listener and the pending-order
      // entry so the symbol+direction isn't blocked as "pending fill" forever.
      if ((data.executionType === "ORDER_CANCELLED" || data.executionType === "ORDER_EXPIRED") && !data.position?.positionId) {
        connection.removeEventListener(fillListenerId);
        state.pendingOrders.delete(label);
        console.log(`[ORDER] ${tag} ${data.executionType === "ORDER_EXPIRED" ? "expired" : "cancelled"} unfilled: ${signal.direction} ${signal.symbol} @ ${entry}`);
        if (!settled) {
          settled = true;
          clearTimeout(placeTimeout);
          connection.removeEventListener(errorListenerId);
          resolve();
        }
        return;
      }

      if (data.executionType === "ORDER_FILLED" && data.position?.positionId) {
        const positionId = Number(data.position.positionId);
        const entryPrice = data.deal?.executionPrice || data.position.price || entry;
        const fillTime = Date.now();
        // SL/TP are already attached to the order broker-side; mirror them onto
        // the in-memory position for display and live monitoring.
        state.positions.set(positionId, {
          symbol: signal.symbol,
          direction: signal.direction,
          volume: lots,
          volumeCents: orderVolume,
          entryPrice,
          openTime: fillTime,
          confidence: signal.confidence,
          source: signal.source,
          ...dealCosts(data.deal, data.position),
          sl,
          tp,
          timeExitMin: timeExitMin > 0 ? timeExitMin : null,
        });
        // Arm the time-based exit from the ACTUAL fill (a resting order may fill
        // hours after placement); the timer counts from here, not from placement.
        recordTimedPosition(positionId, signal.symbol, timeExitMin, fillTime);
        subscribeSpots([symbolId]);
        connection.removeEventListener(fillListenerId);
        state.pendingOrders.delete(label);
        console.log(`[ORDER] ${tag} filled: ${signal.direction} ${lots} lots ${signal.symbol} @ ${entryPrice} | Position #${positionId}`);
        notifyFill(`${tag} order filled`, signal, lots, entryPrice, positionId, restRisk, sl, tp);
        // A marketable resting order can fill instantly without a separate
        // ORDER_ACCEPTED first — settle the placement wait here too.
        if (!settled) {
          settled = true;
          clearTimeout(placeTimeout);
          connection.removeEventListener(errorListenerId);
          resolve();
        }
      }
    });
  });

  try {
    console.log(`[ORDER] Placing ${kind} ${signal.direction} ${lots} lots (${orderVolume} vol) ${signal.symbol} @ ${entry} (label ${label.slice(0, 8)})...`);
    // Staleness guard: with a window, use GOOD_TILL_DATE so the broker expires the
    // order itself (holds across a bot restart); otherwise leave it good-till-cancel.
    // expirationTimestamp is Unix ms.
    const expiry = staleMs > 0 ? { timeInForce: "GOOD_TILL_DATE", expirationTimestamp: Date.now() + staleMs }
                               : { timeInForce: "GOOD_TILL_CANCEL" };
    await connection.sendCommand("ProtoOANewOrderReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      symbolId,
      orderType: kind,
      tradeSide: signal.direction,
      volume: orderVolume,
      // LIMIT uses limitPrice; STOP uses stopPrice (the trigger).
      ...(kind === "STOP" ? { stopPrice: entry } : { limitPrice: entry }),
      ...expiry,
      ...(sl !== null ? { stopLoss: sl } : {}),
      ...(tp !== null ? { takeProfit: tp } : {}),
      label,
    });
    await placement;
    return { ok: true };
  } catch (err: any) {
    state.pendingOrders.delete(label);
    console.log(`[ORDER] ${tag} failed: ${signal.direction} ${signal.symbol} — ${err.message}`);
    return { ok: false, error: err.message || `${kind} order failed` };
  }
}