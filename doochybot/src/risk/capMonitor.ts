import { state, setTradingLock } from "../state";
import { floatingPnL } from "./dailyLoss";
import { closeAllPositions } from "./midnightClose";
import { subscribeOpenPositions, hasLiveQuote } from "../ctrader/livePrices";
import { notify } from "../bot/notify";

// Hard daily profit-cap enforcement. The per-position "cap TP" set on each
// position handles the single-position case (the broker closes it instantly at
// the headroom price, even if the bot is down). But with several positions
// profiting at once, their COMBINED P&L can exceed the cap before any individual
// cap-TP triggers. This monitor is the primary guarantee: it polls the live
// floating P&L every second and force-closes everything the moment
// realized + floating reaches the cap (minus a small safety buffer).
//
// For a prop-firm best-day rule, undershooting the cap is harmless but
// overshooting fails the rule — so we deliberately trigger a hair early.

let closing = false; // guard against re-entrant closes while a sweep is in flight.

// A single breaching tick can be a wick, a spread blip, or an incomplete floating
// sum in the instant before a just-opened position starts streaming. Require the
// breach to persist across this many consecutive polls before force-closing, so a
// one-off spike doesn't lock the day. Mirrors the loss monitor.
const CONFIRM_TICKS = 2;
let breachStreak = 0;

const POLL_MS = 1_000;

// Trigger this many dollars BELOW the cap to absorb the sub-second price move
// between the breach and the close round-trip. Prevents realized from landing
// above the cap. Tunable via /risk capbuffer.
function safetyBuffer(): number {
  return state.settings.capBufferUSD ?? 0;
}

export function startCapMonitor(): void {
  setInterval(async () => {
    const cap = state.settings.dailyProfitCapUSD;
    if (cap <= 0) { breachStreak = 0; return; }
    if (!state.dailyPnLSeeded) { breachStreak = 0; return; }
    if (state.positions.size === 0) { breachStreak = 0; return; }

    // Make sure every open position is streaming live prices, otherwise its
    // floating P&L is invisible and we could miss a breach. Idempotent.
    await subscribeOpenPositions();

    if (closing) return;

    // Critical guard: only decide once EVERY open position has a live quote.
    // floatingPnL() silently skips any position without a mark, so an unquoted
    // LOSER (e.g. one just opened, or right after a restart) is omitted and the
    // realized + floating total is OVERSTATED — which fires the cap while the true
    // realized + unrealized P&L is still below it (banking less than the cap and
    // locking the day early). Wait for the complete picture instead. Same guard the
    // loss monitor uses; the cap monitor was missing it.
    const allQuoted = [...state.positions.values()].every((p) => hasLiveQuote(p.symbol));
    if (!allQuoted) { breachStreak = 0; return; }

    const floating = floatingPnL();
    const total = state.dailyRealizedPnL + floating;
    const trigger = cap - safetyBuffer();
    if (total < trigger) { breachStreak = 0; return; }

    breachStreak++;
    if (breachStreak < CONFIRM_TICKS) return;

    closing = true;
    breachStreak = 0;
    const count = state.positions.size;
    console.log(`[CAP] Breach: realized ${state.dailyRealizedPnL.toFixed(2)} + floating ${floating.toFixed(2)} = ${total.toFixed(2)} >= trigger ${trigger.toFixed(2)} (cap ${cap.toFixed(2)}). Force-closing ${count} position(s).`);
    try {
      const { closed, failed } = await closeAllPositions();
      setTradingLock(true);
      notify(
        `Daily profit cap hit: +${total.toFixed(2)} USD (cap ${cap.toFixed(2)}). ` +
        `Force-closed ${closed}/${count} position(s)${failed ? ` — ${failed} FAILED, check manually` : ""}. ` +
        `New signals blocked until midnight UTC or /resume.`
      );
    } catch (err: any) {
      console.log(`[CAP] Force-close error: ${err.message}`);
    } finally {
      closing = false;
    }
  }, POLL_MS);

  console.log(`[CAP] Profit-cap monitor active (every ${POLL_MS / 1000}s)`);
}
