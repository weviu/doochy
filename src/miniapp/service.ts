import { state, setTradingLock } from "../state";
import { closeAllPositions } from "../risk/midnightClose";

// The Mini App API reuses the same live broker connection every other module
// points at, wired in index.ts wireConnection() (and re-wired on reconnect).
let connection: any = null;

export function setMiniAppConnection(conn: any): void {
  connection = conn;
}

export function getConnection(): any {
  return connection;
}

// --- Actions (v1: basic controls, mirroring the Telegram commands) ----------

// Mirrors /pause.
export function pauseTrading(): void {
  state.paused = true;
}

// Mirrors /resume: clears the pause and any daily-limit lock (the manual reset
// before the automatic midnight-UTC one).
export function resumeTrading(): { wasLocked: boolean } {
  const wasLocked = state.tradingLocked;
  state.paused = false;
  setTradingLock(false);
  return { wasLocked };
}

// Mirrors /closeall.
export async function closeAll(): Promise<{ closed: number; failed: number; total: number }> {
  const total = state.positions.size;
  if (total === 0) return { closed: 0, failed: 0, total: 0 };
  const { closed, failed } = await closeAllPositions();
  return { closed, failed, total };
}
