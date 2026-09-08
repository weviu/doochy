import { primaryRuntimes, RuntimeState } from "../state";
import { adoptExternalPositions } from "../ctrader/orders";
import { amendPositionSLTP } from "../ctrader/amend";
import { sendWhere, envForAccount, connectionFor } from "../ctrader/environments";

// Stop-loss safety net. The post-fill amend that attaches a stop loss can fail
// silently (a sent amend whose ORDER_REPLACED confirmation never arrives), which
// would leave an open position unprotected. This watchdog is not a fix for that
// race; it is a backstop. Every 60s it asks the broker for the real, broker-side
// SL on every open position of every traded account and re-sends the amendment
// for any that has none.
//
// It also serves as the guaranteed periodic adoption of positions opened outside
// the bot (directly in the cTrader platform): the fill-event path in orders.ts is
// the fast route, but this ensures such a position is picked up within 60s even if
// no execution event reaches our session.

const POLL_MS = 60_000;

async function checkAccount(rt: RuntimeState): Promise<void> {
  const env = envForAccount(rt.ctid);
  if (env === undefined || !connectionFor(env)) return;

  // Adopt any externally-opened position BEFORE the SL check, so a position we
  // weren't tracking still gets its stop verified this same cycle. Runs even
  // when we currently track nothing (that is exactly the case where an external
  // position would otherwise stay invisible and unprotected).
  await adoptExternalPositions(rt.ctid);
  if (rt.positions.size === 0) return;

  let res: any;
  try {
    res = await sendWhere("ProtoOAReconcileReq", {
      ctidTraderAccountId: rt.ctid,
    });
  } catch (err: any) {
    console.warn(`[SL-WATCHDOG] Reconcile failed for account ${rt.ctid}: ${err.errorCode || err.message || "request failed"}`);
    return;
  }

  // Broker-side stop loss per position id (0/absent means no SL on the broker).
  const brokerSL = new Map<number, number>();
  for (const p of res.position || []) {
    brokerSL.set(Number(p.positionId), p.stopLoss ? Number(p.stopLoss) : 0);
  }

  for (const [pid, pos] of rt.positions.entries()) {
    const sl = brokerSL.get(pid) ?? 0;
    if (sl > 0) continue; // protected, nothing to do

    console.log(`[SL-WATCHDOG] Position #${pid} ${pos.direction} ${pos.symbol} has NO broker-side SL - re-sending amendment`);
    try {
      // Re-send our intended SL/TP. amendPositionSLTP recomputes a percentage
      // SL when none is stored, and sends SL immediately even inside min-hold.
      await amendPositionSLTP(rt, pid, pos.symbol, pos.entryPrice, pos.direction, {
        sl: pos.sl ?? undefined,
        tp: pos.tp ?? undefined,
      });
    } catch (err: any) {
      console.warn(`[SL-WATCHDOG] Re-amend failed for #${pid}: ${err.message}`);
    }
  }
}

export function startStopLossWatchdog(): void {
  setInterval(() => {
    for (const rt of primaryRuntimes()) {
      checkAccount(rt).catch((err: any) => console.warn(`[SL-WATCHDOG] Account ${rt.ctid} check failed: ${err.message}`));
    }
  }, POLL_MS);

  console.log(`[SL-WATCHDOG] Stop-loss watchdog active (every ${POLL_MS / 1000}s, ${primaryRuntimes().length} account(s))`);
}