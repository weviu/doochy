import { state } from "../state";
import { clearTimedPosition } from "./timeExit";
import { primaryAccountId } from "../ctrader/accounts";

let connection: any = null;

export function setMidnightConnection(conn: any): void {
  connection = conn;
}

// Close a single position by id. Returns true on success. On success the
// position is removed from state.positions. On failure it stays tracked (still
// open). Shared by closeAllPositions and the reversal logic.
export async function closePosition(positionId: number): Promise<boolean> {
  const pos = state.positions.get(positionId);
  if (!pos) return false;
  try {
    await connection.sendCommand("ProtoOAClosePositionReq", {
      ctidTraderAccountId: primaryAccountId(),
      positionId,
      volume: pos.volumeCents,
    });
    console.log(`[CLOSE] Closed position #${positionId} ${pos.symbol}`);
    state.positions.delete(positionId);
    clearTimedPosition(positionId);
    return true;
  } catch (err: any) {
    console.log(`[CLOSE] Failed to close position #${positionId} ${pos.symbol} — ${err.message}`);
    return false;
  }
}

// Close every open position. Shared by the midnight safety closer and the
// /closeall command. Closes are attempted per-position; one failure does not
// stop the others. Returns counts so callers can report results.
export async function closeAllPositions(): Promise<{ closed: number; failed: number }> {
  const ids = [...state.positions.keys()];
  if (ids.length === 0) return { closed: 0, failed: 0 };

  let closed = 0;
  let failed = 0;
  for (const positionId of ids) {
    if (await closePosition(positionId)) closed++;
    else failed++;
  }

  console.log(`[CLOSE] All ${closed} positions closed${failed ? ` (${failed} failed, still open)` : ""}`);
  return { closed, failed };
}

// NOTE: the old startMidnightCheck (21:55 UTC flatten) lived here but was never
// wired into either entrypoint. Its job — flattening ahead of the broker's
// daily reset — now belongs to the risk engine's pre-reset window (see
// risk/engine.ts + risk/tradingDay.ts), which runs on the broker's actual
// midnight, not a hardcoded UTC guess. This module keeps only the shared
// close-position helpers.
