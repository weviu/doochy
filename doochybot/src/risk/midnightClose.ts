import { state } from "../state";
import { clearTimedPosition } from "./timeExit";

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
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
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

// cTrader accounts reset the daily loss limit at midnight CET, which is 22:00
// UTC in winter (CEST is 23:00 UTC). We close 5 minutes before the earliest
// possible reset — 21:55 UTC — to protect prop-firm accounts.
const CLOSE_HOUR_UTC = 21;
const CLOSE_MINUTE_UTC = 55;

export function startMidnightCheck(): void {
  let triggeredToday = false;
  let lastDay = new Date().getUTCDate();

  setInterval(async () => {
    const now = new Date();

    // Reset the once-per-day flag when the UTC day rolls over.
    const day = now.getUTCDate();
    if (day !== lastDay) {
      lastDay = day;
      triggeredToday = false;
    }

    const h = now.getUTCHours();
    const m = now.getUTCMinutes();

    if (h === CLOSE_HOUR_UTC && m >= CLOSE_MINUTE_UTC && !triggeredToday) {
      triggeredToday = true;
      if (state.positions.size > 0) {
        const count = state.positions.size;
        const { closed } = await closeAllPositions();
        console.log(`[SAFETY] Midnight safety: closed ${closed} positions before daily reset (had ${count})`);
      }
    }
  }, 60_000);
}
