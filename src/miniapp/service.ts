import { state, primaryRuntimes } from "../state";
import { closeAllPositions } from "../risk/midnightClose";
import { resumeTrading as engineResume } from "../risk/engine";
import { storeConnection, allConnections, EnvName } from "../ctrader/environments";

// The Mini App API reuses the same live broker connections the other modules
// point at (stored per environment), re-wired on every reconnect.
export function setMiniAppConnection(env: EnvName, conn: any): void {
  storeConnection(env, conn);
}

export function getConnection(): any {
  for (const [, conn] of allConnections()) {
    if (conn) return conn;
  }
  return null;
}

// --- Actions (v1: basic controls, mirroring the Telegram commands) ----------

// Mirrors /pause.
export function pauseTrading(): void {
  state.paused = true;
}

// Mirrors /resume: clears the pause and any daily-limit lock; a cleared lock
// also overrides the daily limits until the next broker trading day (see the
// risk engine, the single owner of that logic). Applies to every traded account.
export function resumeTrading(): { wasLocked: boolean } {
  let wasLocked = false;
  for (const rt of primaryRuntimes()) {
    wasLocked = engineResume(rt).wasLocked || wasLocked;
  }
  return { wasLocked };
}

// Mirrors /closeall.
export async function closeAll(): Promise<{ closed: number; failed: number; total: number }> {
  let total = 0;
  let closed = 0;
  let failed = 0;
  for (const rt of primaryRuntimes()) {
    total += rt.positions.size;
    const res = await closeAllPositions(rt);
    closed += res.closed;
    failed += res.failed;
  }
  return { closed, failed, total };
}