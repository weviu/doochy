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

// Polling for SL/TP after a fill. The source account is traded BY HAND: the
// entry, the SL and the TP are three separate actions, so protection appears
// gradually over as long as it takes a person to set it, not in one broker
// message. Poll every 10s for up to 2 minutes, and settle as soon as BOTH levels
// are present - so a fast placement copies quickly and a slow one still copies
// correctly rather than being frozen at whatever existed at one arbitrary moment.
const SETTLE_MS = 10_000;
const SETTLE_RETRIES = 12;

// Read a position's live SL/TP from the broker rather than the fill event.
// Returns nulls if the position genuinely has no protection (a real case worth
// reporting) or if the query fails.
async function settledLevels(positionId: number, symbol: string, ctid: number): Promise<{ sl: number | null; tp: number | null }> {
  const level = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  // Best result seen so far. A human placing an entry by hand sets SL and TP as
  // two separate actions, so a poll can legitimately catch the position
  // half-protected. Keep whatever was found and keep waiting for the rest.
  let best: { sl: number | null; tp: number | null } = { sl: null, tp: null };
  let lastReported = "";

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
      best = { sl: level(found.stopLoss) ?? best.sl, tp: level(found.takeProfit) ?? best.tp };
      // Require BOTH before settling. Returning on either one (the earlier bug)
      // copied a half-set position the moment the SL landed, losing the TP that
      // was seconds away and guaranteeing a downstream rejection.
      if (best.sl !== null && best.tp !== null) return best;
      // Log only when the picture changes, not on every poll: at a 10s tick over
      // two minutes an unchanged "still waiting" line would just be noise.
      const have = best.sl !== null ? "SL only" : best.tp !== null ? "TP only" : "no SL/TP";
      if (have !== lastReported) {
        lastReported = have;
        console.log(`[COPYTRADE] Position #${positionId} (${symbol}): ${have} after ${attempt * (SETTLE_MS / 1000)}s, waiting for the rest`);
      }
    } catch (err: any) {
      console.warn(`[COPYTRADE] Could not read levels for #${positionId} (${symbol}): ${err.errorCode || err.message || err}`);
    }
  }
  return best;
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
    console.warn(`[COPYTRADE] Position #${positionId} (${symbol}): still no ${sl === null ? "SL" : "TP"} after ${(SETTLE_MS * SETTLE_RETRIES) / 1000}s; writing anyway, but downstream will reject it`);
  }

  // Two destinations, chosen by config:
  //  - COPYTRADE_WEBHOOK_URL set: this box saw the fill but does NOT host the
  //    feed, so POST the fill to the receiver, which owns the write (and the
  //    dedup + collision handling). This is the friend-on-a-separate-box case.
  //  - unset: write the local alerts.json directly (single-box / original setup).
  const webhookUrl = (process.env.COPYTRADE_WEBHOOK_URL || "").trim();
  if (webhookUrl) {
    await sendToWebhook(webhookUrl, { positionId, symbol, direction, price, sl, tp });
    return;
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

// POST a fill to the remote receiver. The receiver owns the write, so it also
// owns dedup: on the local-write path markWritten() runs here, but over the wire
// the receiver records the id, and its 200 (including "already recorded") means
// the fill is safely accounted for. A failure is logged as a real gap - the fill
// was seen but not copied - never silently dropped.
async function sendToWebhook(
  url: string,
  fill: { positionId: number; symbol: string; direction: "buy" | "sell"; price: number; sl: number | null; tp: number | null }
): Promise<void> {
  const secret = (process.env.COPYTRADE_WEBHOOK_SECRET || "").trim();
  const payload = { ...fill, signal_source: SIGNAL_SOURCE };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[COPYTRADE] GAP: receiver rejected fill #${fill.positionId} (${fill.symbol}): HTTP ${res.status} ${detail}. This fill was NOT copied.`);
      return;
    }
    console.log(`[COPYTRADE] Sent ${fill.direction.toUpperCase()} ${fill.symbol} @ ${fill.price} (SL ${fill.sl ?? "none"} / TP ${fill.tp ?? "none"}) from position #${fill.positionId} to receiver`);
  } catch (err: any) {
    console.error(`[COPYTRADE] GAP: could not reach copy-alert receiver for fill #${fill.positionId} (${fill.symbol}): ${err.message}. This fill was NOT copied.`);
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
