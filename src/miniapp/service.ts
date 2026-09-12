import { state, primaryRuntimes, runtimeFor, RuntimeState } from "../state";
import { primaryAccounts } from "../ctrader/accounts";
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

// Pause trading. With a ctid this pauses ONLY that account (independent of the
// others); without, it pauses every account (the global master switch).
export function pauseTrading(ctid?: number): void {
  if (ctid !== undefined) {
    const isPrimary = primaryAccounts().some((a) => a.ctid === ctid);
    if (isPrimary) {
      runtimeFor(ctid).paused = true;
      return;
    }
  }
  state.paused = true;
}

// Resume trading: clears the account's own pause and any daily-limit lock; a
// cleared lock also overrides the daily limits until the next broker trading day
// (see the risk engine, the single owner of that logic). The global master pause
// is ALWAYS lifted — a resume means "let trading happen" — while with a ctid the
// cleared lock/own-pause applies to ONLY that account; without, every traded
// account.
export function resumeTrading(ctid?: number): { wasLocked: boolean } {
  let wasLocked = false;
  const targets: RuntimeState[] =
    ctid === undefined
      ? primaryRuntimes()
      : primaryRuntimes().filter((rt) => rt.ctid === ctid);
  for (const rt of targets) {
    wasLocked = engineResume(rt).wasLocked || wasLocked;
  }
  state.paused = false;
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