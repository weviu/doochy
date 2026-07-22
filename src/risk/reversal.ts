import { state, Position } from "../state";
import { ParsedSignal } from "../signals/types";
import { closePosition } from "./midnightClose";
import { executeSignal } from "../ctrader/orders";
import { notify } from "../bot/notify";

// Flip a position: close the existing one, wait briefly so cTrader settles the
// close, then open the opposite-direction signal. Only called by the gate after
// it has confirmed the new signal's confidence is strictly higher.
export async function executeReversal(
  positionId: number,
  existing: Position,
  signal: ParsedSignal
): Promise<void> {
  // Step 1 — close the existing position. closePosition removes it from
  // state.positions on success.
  const closed = await closePosition(positionId);
  if (!closed) {
    console.log(`[REVERSAL] Aborted — failed to close ${existing.direction} ${existing.symbol} #${positionId}. Existing position stays open.`);
    return;
  }
  console.log(`[REVERSAL] Closed ${existing.direction} ${existing.symbol} #${positionId}`);

  // Step 2 — brief delay so the broker processes the close before the new order.
  await new Promise((r) => setTimeout(r, 1000));

  // Step 3 — open the new position. A reversal is a deliberate "flip now": we've
  // just closed and gone flat, so the entry must fill immediately. Force a MARKET
  // order (executeSignal's feed decision would otherwise rest a stop/limit at the
  // signal's target, leaving us flat and tripping the unhedged alarm below). Set
  // it on a copy so we never mutate the caller's signal.
  const marketSignal: ParsedSignal = { ...signal, orderType: "MARKET" };
  // executeSignal handles its own errors, so we verify success by checking a
  // matching position actually opened.
  try {
    await executeSignal(marketSignal);
  } catch (err: any) {
    console.log(`[REVERSAL] executeSignal threw: ${err.message}`);
  }

  const opened = [...state.positions.values()].some(
    (p) => p.symbol === signal.symbol && p.direction === signal.direction
  );

  if (opened) {
    console.log(`[REVERSAL] Opened ${signal.direction} ${signal.symbol}`);
  } else {
    const msg = `CRITICAL: closed ${existing.direction} ${existing.symbol} #${positionId} but new ${signal.direction} ${signal.symbol} did NOT open — account may be unhedged`;
    console.log(`[REVERSAL] ${msg}`);
    await notify(msg);
  }
  // P&L from the close is handled by the normal position-close tracking.
}
