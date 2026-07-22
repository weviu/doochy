import { state } from "../../state";
import { closePosition } from "../midnightClose";
import { cancelRestingOrdersForSymbol } from "../../ctrader/orders";
import { notify } from "../../bot/notify";
import { getNewsConfig } from "./config";
import { refresh, shouldFlatten, markFlattened, symbolInScope, upcomingInScope, cacheStatus } from "./calendar";
import { EconomicEvent } from "./types";

// How often the monitor ticks. 60s is plenty: the flatten window is flattenLeadMin
// wide (30m default), so any tick inside it fires, and the idempotency marker makes
// it once-only. Matches the cadence of the other risk monitors.
const TICK_MS = 60_000;

let refreshing = false; // guard overlapping refreshes
let flattening = false; // guard re-entrant flattens while a close sweep is in flight
let lastRefreshAt = 0;

// Minutes until an event, for logs like "in 28m".
function minsUntil(now: number, eventMs: number): number {
  return Math.round((eventMs - now) / 60_000);
}

// Close all in-scope open positions and cancel all in-scope resting orders because
// `event` is within its flatten window. Idempotent per event: the marker is set so
// no later tick re-issues this, and a position re-opened after the event isn't
// flattened again by the same event.
async function flattenForEvent(event: EconomicEvent, now: number): Promise<void> {
  const cfg = getNewsConfig();
  flattening = true;
  try {
    const eta = minsUntil(now, event.time!);
    const inScopePositions = [...state.positions.entries()].filter(([, p]) => symbolInScope(p.symbol, cfg));

    let closed = 0;
    let failed = 0;
    for (const [id, pos] of inScopePositions) {
      const ok = await closePosition(id);
      if (ok) {
        closed++;
        console.log(`[news] flattened ${pos.symbol} ${pos.direction === "BUY" ? "long" : "short"} - ${event.title} (${event.currency}/${event.impact}) in ${eta}m`);
      } else {
        failed++;
        console.warn(`[news] FAILED to flatten ${pos.symbol} #${id} for ${event.title} - still open`);
      }
    }

    // Cancel any resting stop/limit for each in-scope symbol so nothing fills into
    // the print. Deduplicate symbols so we reconcile once per symbol.
    let cancelled = 0;
    for (const symbol of cfg.symbols) {
      cancelled += await cancelRestingOrdersForSymbol(symbol);
    }

    // Mark the event handled ONLY when we're actually flat (no failed closes). The
    // `flattening` guard already prevents overlapping ticks, so we don't need a
    // pre-mark for the race; leaving it unmarked on failure lets the next tick
    // retry the close (a stuck position near a news print is worth retrying on a
    // prop account). Once marked, no later tick re-issues it, and a position
    // re-opened after the event isn't flattened again by the same event.
    if (failed === 0) {
      markFlattened(event.id, now);
    } else {
      console.warn(`[news] ${failed} position(s) failed to flatten for ${event.title} - will retry next tick`);
    }

    if (closed > 0 || cancelled > 0) {
      const msg = `News flatten: ${event.title} (${event.currency}/${event.impact}) in ${eta}m - closed ${closed} position(s), cancelled ${cancelled} order(s)${failed ? `, ${failed} FAILED (retrying)` : ""}`;
      console.log(`[news] ${msg}`);
      if (state.settings.notifyFills) notify(msg);
    } else {
      console.log(`[news] flatten window for ${event.title} in ${eta}m: no in-scope positions or orders open`);
    }
  } catch (err: any) {
    console.warn(`[news] flatten error for ${event.title}: ${err.message}`);
  } finally {
    flattening = false;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const cfg = getNewsConfig();

  // Periodic refresh (calendars change rarely; be a polite client). Runs off the
  // same tick so there's no second timer to manage.
  if (!refreshing && now - lastRefreshAt >= cfg.refreshHours * 3600_000) {
    refreshing = true;
    lastRefreshAt = now; // set before await so a slow fetch doesn't stack refreshes
    refresh()
      .catch((err) => console.warn(`[news] scheduled refresh error: ${err.message}`))
      .finally(() => { refreshing = false; });
  }

  if (flattening || state.positions.size === 0) return;

  // Find the first in-scope symbol whose flatten window is open and unhandled.
  for (const [, pos] of state.positions.entries()) {
    if (!symbolInScope(pos.symbol, cfg)) continue;
    const decision = shouldFlatten(now, pos.symbol, cfg);
    if (decision.flatten && decision.event) {
      await flattenForEvent(decision.event, now);
      return; // flattenForEvent closes ALL in-scope positions; nothing left to scan
    }
  }
}

// Start the news guard: do an initial calendar fetch, then tick every TICK_MS to
// refresh periodically and run the pre-news flatten. Call once at boot after the
// broker connection is wired (closePosition/cancel need it).
export async function startNewsMonitor(): Promise<void> {
  const boot = await refresh();
  lastRefreshAt = Date.now();
  const status = cacheStatus();
  console.log(
    `[news] monitor active (tick ${TICK_MS / 1000}s). Initial calendar: ${boot.ok ? "fetched" : "FAILED (" + boot.error + ")"}, ` +
    `${status.count} cached events. Next in-scope events: ${upcomingInScope(Date.now()).length}`
  );

  setInterval(() => {
    tick().catch((err) => console.warn(`[news] tick error: ${err.message}`));
  }, TICK_MS);
}
