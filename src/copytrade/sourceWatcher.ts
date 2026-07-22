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

// symbolId -> name. state.symbolMap is name -> id and is populated from the
// PRIMARY account, but symbol ids are broker-wide (both accounts are on the same
// broker under one grant), so reversing it resolves the source's fills too.
function symbolNameFor(symbolId: number): string | undefined {
  for (const [name, id] of state.symbolMap.entries()) {
    if (id === symbolId) return name;
  }
  return undefined;
}

function handleFill(data: any): void {
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

  const sl = Number.isFinite(Number(pos?.stopLoss)) && Number(pos?.stopLoss) !== 0 ? Number(pos.stopLoss) : null;
  const tp = Number.isFinite(Number(pos?.takeProfit)) && Number(pos?.takeProfit) !== 0 ? Number(pos.takeProfit) : null;
  if (sl === null || tp === null) {
    // Downstream sizing derives volume from the entry-to-SL distance, so an
    // alert without both levels is rejected at the gate anyway. Say so here.
    console.warn(`[COPYTRADE] Position #${positionId} (${symbol}): missing ${sl === null ? "SL" : "TP"}; writing anyway, but downstream will likely reject it`);
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

    handleFill(data);
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
