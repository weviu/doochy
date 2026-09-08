import { RuntimeState } from "../state";
import { clearTimedPosition } from "./timeExit";
import { sendWhere, storeConnection, EnvName } from "../ctrader/environments";

export function setMidnightConnection(env: EnvName, conn: any): void {
  storeConnection(env, conn);
}

// Close a single position on ONE account by id. Returns true on success. On
// success the position is removed from that account's rt.positions. On failure
// it stays tracked (still open). Shared by closeAllPositions, the reversal
// logic, and the manual-close command.
export async function closePosition(rt: RuntimeState, positionId: number): Promise<boolean> {
  const pos = rt.positions.get(positionId);
  if (!pos) return false;
  try {
    await sendWhere("ProtoOAClosePositionReq", {
      ctidTraderAccountId: rt.ctid,
      positionId,
      volume: pos.volumeCents,
    });
    console.log(`[CLOSE] Closed position #${positionId} ${pos.symbol} (account ${rt.ctid})`);
    rt.positions.delete(positionId);
    clearTimedPosition(rt.ctid, positionId);
    return true;
  } catch (err: any) {
    console.log(`[CLOSE] Failed to close position #${positionId} ${pos.symbol} — ${err.message}`);
    return false;
  }
}

// Close every open position on ONE account. Shared by the midnight safety
// closer and the /closeall command. Closes are attempted per-position; one
// failure does not stop the others. Returns counts so callers can report
// results.
export async function closeAllPositions(rt: RuntimeState): Promise<{ closed: number; failed: number }> {
  const ids = [...rt.positions.keys()];
  if (ids.length === 0) return { closed: 0, failed: 0 };

  let closed = 0;
  let failed = 0;
  for (const positionId of ids) {
    if (await closePosition(rt, positionId)) closed++;
    else failed++;
  }

  console.log(`[CLOSE] All ${closed} positions closed (account ${rt.ctid})${failed ? ` (${failed} failed, still open)` : ""}`);
  return { closed, failed };
}

// NOTE: the old startMidnightCheck (21:55 UTC flatten) lived here but was never
// wired into either entrypoint. Its job — flattening ahead of the broker's
// daily reset — now belongs to the risk engine's pre-reset window (see
// risk/engine.ts + risk/tradingDay.ts), which runs on the broker's actual
// midnight, not a hardcoded UTC guess. This module keeps only the shared
// close-position helpers.