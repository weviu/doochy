import { state } from "../state";
import { accountsByRole } from "../ctrader/accounts";
import { alreadyWritten, markWritten } from "./writtenPositions";
import { prependAlert } from "./alertsFile";

// Watches the "source" role account (a demo account traded manually by a human
// clicking Autochartist's suggested entries) and writes each newly FILLED
// position into the alerts feed as a copy-trade signal.
//
// ENTRY ONLY, v1. The source account's TP/SL are fixed at execution time and
// never change, so there is deliberately no close-sync, no modify-sync and no
// position lifecycle tracking here. Each downstream doochybot runs its own copy
// to its own conclusion.

export const SOURCE_ROLE = "source";
export const SIGNAL_SOURCE = "autochartist_copy";

// The source account has no inherent timeframe the way a scanner does: a human
// clicking an Autochartist suggestion produces no chart interval, and
// ProtoOAExecutionEvent carries none. Emitted as null rather than inventing a
// plausible-looking value, since asserting "15m" would be untrue about where the
// signal came from. Nothing downstream gates on timeframe.
const TIMEFRAME = null;

let listenerId: string | null = null;
let watchedCtids: number[] = [];
let conn: any = null;
// Positions currently mid-write. The disk guard is only consulted before the
// settle wait, so without this a second event for the same fill arriving during
// those seconds would pass the check and write a duplicate alert.
const inFlight = new Set<number>();

// symbolId -> name. state.symbolMap is name -> id and is populated from the
// PRIMARY account, but symbol ids are broker-wide (both accounts are on the same
// broker under one grant), so reversing it resolves the source's fills too.
function symbolNameFor(symbolId: number): string | undefined {
  for (const [name, id] of state.symbolMap.entries()) {
    if (id === symbolId) return name;
  }
  return undefined;
}

// How long to let the broker attach SL/TP before reading the position back.
// Long enough to cover the gap observed live (levels absent at fill, present a
// moment later), short enough that the copied alert stays close to the fill.
const SETTLE_MS = 3000;
// If the first read still shows no levels, try once more: an Autochartist entry
// occasionally takes longer to have protection written.
const SETTLE_RETRIES = 2;

// Read a position's live SL/TP from the broker rather than the fill event.
// Returns nulls if the position genuinely has no protection (a real case worth
// reporting) or if the query fails.
async function settledLevels(positionId: number, symbol: string, ctid: number): Promise<{ sl: number | null; tp: number | null }> {
  const level = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  for (let attempt = 1; attempt <= SETTLE_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (!conn) break;
    try {
      // Query the account the fill actually came from rather than assuming a
      // single source: several accounts may hold the source role.
      const res = await conn.sendCommand("ProtoOAReconcileReq", { ctidTraderAccountId: ctid });
      const found = (res?.position ?? []).find((p: any) => Number(p.positionId) === positionId);
      if (!found) {
        // Closed again already, or not visible on this account. Nothing to read.
        console.warn(`[COPYTRADE] Position #${positionId} (${symbol}) not found on reconcile (attempt ${attempt}/${SETTLE_RETRIES})`);
        continue;
      }
      const sl = level(found.stopLoss);
      const tp = level(found.takeProfit);
      if (sl !== null || tp !== null) return { sl, tp };
      console.log(`[COPYTRADE] Position #${positionId} (${symbol}): no SL/TP yet after ${attempt * (SETTLE_MS / 1000)}s, retrying`);
    } catch (err: any) {
      console.warn(`[COPYTRADE] Could not read levels for #${positionId} (${symbol}): ${err.errorCode || err.message || err}`);
    }
  }
  return { sl: null, tp: null };
}

async function handleFill(data: any): Promise<void> {
  const pos = data.position;
  const positionId = Number(pos?.positionId);
  if (!Number.isFinite(positionId)) return;

  if (alreadyWritten(positionId)) {
    // Expected whenever two connections serve this account at once, or after a
    // restart that replays an event. Logged, not silent, so a runaway duplicate
    // rate is visible rather than hidden.
    console.log(`[COPYTRADE] Position #${positionId} already written; skipping duplicate`);
    return;
  }
  // Claim it for the duration of the settle wait (see inFlight).
  if (inFlight.has(positionId)) {
    console.log(`[COPYTRADE] Position #${positionId} already being written; skipping duplicate`);
    return;
  }
  inFlight.add(positionId);
  try {
    await writeFill(data, positionId);
  } finally {
    inFlight.delete(positionId);
  }
}

async function writeFill(data: any, positionId: number): Promise<void> {
  const pos = data.position;

  const symbolId = Number(pos?.tradeData?.symbolId);
  const symbol = Number.isFinite(symbolId) ? symbolNameFor(symbolId) : undefined;
  if (!symbol) {
    console.warn(`[COPYTRADE] Position #${positionId}: symbolId ${pos?.tradeData?.symbolId ?? "?"} not in the symbol map; cannot name the instrument, skipping this copy`);
    return;
  }

  const rawSide = String(pos?.tradeData?.tradeSide || "").toUpperCase();
  if (rawSide !== "BUY" && rawSide !== "SELL") {
    console.warn(`[COPYTRADE] Position #${positionId} (${symbol}): unrecognised tradeSide "${pos?.tradeData?.tradeSide}", skipping`);
    return;
  }
  const direction = rawSide.toLowerCase() as "buy" | "sell";

  // Same fields orders.ts uses for its own fills: these arrive already scaled,
  // so they are used as-is with no digits division.
  const price = Number(data.deal?.executionPrice ?? pos?.price);
  if (!Number.isFinite(price)) {
    console.warn(`[COPYTRADE] Position #${positionId} (${symbol}): no usable fill price, skipping`);
    return;
  }

  // SL/TP are NOT on the position at ORDER_FILLED: cTrader opens the position
  // first and attaches protection in a separate message moments later. Reading
  // them off the fill event gave null every time even though the trade plainly
  // had both. orders.ts already documents this race ("a market fill restarted
  // mid-minhold before its TP was sent"), and its own reconcile path reads the
  // levels from a position QUERY rather than the event - do the same here.
  const { sl, tp } = await settledLevels(positionId, symbol, Number(data?.ctidTraderAccountId));
  if (sl === null || tp === null) {
    // Downstream sizing derives volume from the entry-to-SL distance, so an
    // alert without an SL is rejected at the gate. Worth saying loudly: after the
    // settle wait this means the trade really has no protection attached, not
    // that we read it too early.
    console.warn(`[COPYTRADE] Position #${positionId} (${symbol}): still no ${sl === null ? "SL" : "TP"} after settling; writing anyway, but downstream will reject it`);
  }

  const filledAt = new Date();
  try {
    const { written, bumpedBy } = prependAlert(
      {
        symbol,
        timeframe: TIMEFRAME,
        direction,
        rsi: null,
        price,
        current_price: price,
        pivot_level: null,
        pivot_distance: null,
        confidence: 100.0,
        sl,
        tp,
        time_exit_min: null,
        src_bar: null,
        btc_state: null,
        // The ONLY field distinguishing this from a scanner alert. Downstream
        // filtering depends entirely on it, so it is set on every write.
        signal_source: SIGNAL_SOURCE,
      },
      filledAt
    );

    // Persist the id only after the alert is safely on disk. The reverse order
    // could mark a position written whose alert never landed.
    markWritten(positionId);

    const bumpNote = bumpedBy > 0
      ? ` (fill was ${bumpedBy}s earlier at ${new Date(filledAt.getTime()).toISOString().slice(11, 19)} UTC; bumped to avoid a same-second collision)`
      : "";
    console.log(`[COPYTRADE] Copied ${direction.toUpperCase()} ${symbol} @ ${price} (SL ${sl ?? "none"} / TP ${tp ?? "none"}) from position #${positionId} -> alert ${written}${bumpNote}`);
  } catch (err: any) {
    console.error(`[COPYTRADE] FAILED to write alert for position #${positionId} (${symbol}): ${err.message}. This fill was NOT copied.`);
  }
}

// Attach to a live connection. Called on first connect and again after every
// reconnect; the previous listener died with the old socket.
export function watchSourceAccount(connection: any): void {
  const sources = accountsByRole(SOURCE_ROLE);
  watchedCtids = sources.map((a) => a.ctid);
  // Kept so the settle read can query the broker on the CURRENT socket; a
  // reconnect replaces this with the new one.
  conn = connection;

  if (watchedCtids.length === 0) {
    console.log("[COPYTRADE] No account has the \"source\" role; copy-trade subscriber is idle");
    return;
  }

  listenerId = connection.on("ProtoOAExecutionEvent", (event: any) => {
    const data = event.descriptor ?? event;

    // The execution listener is per-CONNECTION, not per-account, and the primary
    // account's own fills arrive on this very same socket. Without this filter
    // the bot would copy its own trades back into the feed. Every event is
    // matched against the source ctid before anything else happens.
    const ctid = Number(data?.ctidTraderAccountId);
    if (!Number.isFinite(ctid) || !watchedCtids.includes(ctid)) return;

    if (data.executionType !== "ORDER_FILLED") return;
    if (!data.position?.positionId) return;

    // Fire and forget: the handler now waits a few seconds for the broker to
    // attach SL/TP, and the listener must not block the socket meanwhile. Any
    // failure is logged inside; nothing here can reject.
    handleFill(data).catch((err: any) => {
      console.error(`[COPYTRADE] Unhandled error while copying a fill: ${err?.message || err}`);
    });
  });

  console.log(`[COPYTRADE] Subscriber live: watching ${watchedCtids.join(", ")} for fills, writing "${SIGNAL_SOURCE}" alerts`);
}

// Announce a gap. The subscriber cannot see fills while the connection is down,
// and there is no reliable "positions opened since X" query on this API
// (ProtoOAPositionListReq does not exist; ProtoOADealListReq returns deal history,
// and reconstructing open-position state from it is lifecycle tracking, which is
// out of scope for v1). So a gap is reported, never backfilled.
export function reportSourceGap(reason: string, downSince: number | null): void {
  if (watchedCtids.length === 0) return;
  const forNote = downSince ? ` for ${Math.round((Date.now() - downSince) / 1000)}s` : "";
  console.warn(`[COPYTRADE] GAP: source account not watched${forNote} (${reason}). Any Autochartist fills in this window were NOT copied and cannot be backfilled.`);
}
