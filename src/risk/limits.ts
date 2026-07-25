// Pure daily-limit decision logic: numbers in, verdict out. No state, no I/O,
// no timers — the engine feeds it live figures and acts on the verdict; tests
// feed it fixtures. Keep it dependency-free so the whole limit matrix stays
// unit-testable without touching the broker stack.

export interface LimitInputs {
  seeded: boolean;        // realized P&L successfully seeded from the broker
  override: boolean;      // user ran /resume after a lock: limits off for the rest of the day
  realized: number;       // today's realized P&L, USD
  floating: number;       // unrealized P&L across ALL open positions, USD
  complete: boolean;      // floating covers every open position (no missing quote/rate)
  maxLossUSD: number;     // positive; 0 = loss limit disabled
  capUSD: number;         // daily profit cap; 0 = disabled
  capBufferUSD: number;   // trigger this many $ below the cap
}

export type LimitVerdict =
  | { kind: "OK"; total: number }
  | { kind: "UNSEEDED" }
  | { kind: "OVERRIDDEN"; total: number }
  // Floating is missing at least one position. `realizedOnly` is the verdict of
  // re-deciding on realized alone: a realized-alone breach is unambiguous (the
  // money is already lost/banked) and still counts; anything else is a "wait
  // for full data" — never act on a floating figure we can't trust.
  | { kind: "INCOMPLETE"; realizedOnly: LimitVerdict }
  | { kind: "LOSS_BREACH"; total: number; limit: number }
  | { kind: "CAP_BREACH"; total: number; cap: number; trigger: number };

export function decideLimits(i: LimitInputs): LimitVerdict {
  if (!i.seeded) return { kind: "UNSEEDED" };

  const total = i.realized + i.floating;
  if (i.override) return { kind: "OVERRIDDEN", total };

  if (!i.complete) {
    return {
      kind: "INCOMPLETE",
      realizedOnly: decideLimits({ ...i, floating: 0, complete: true }),
    };
  }

  // Profit cap first (matches the old lock order): trigger sits `capBufferUSD`
  // below the cap so the close round-trip can't overshoot a best-day rule.
  if (i.capUSD > 0) {
    const trigger = i.capUSD - i.capBufferUSD;
    if (total >= trigger) return { kind: "CAP_BREACH", total, cap: i.capUSD, trigger };
  }

  // Loss limit is a positive number; breach when combined P&L reaches -limit.
  // The > 0 guard matters: a limit of 0 means "disabled", not "any loss".
  if (i.maxLossUSD > 0 && total <= -i.maxLossUSD) {
    return { kind: "LOSS_BREACH", total, limit: i.maxLossUSD };
  }

  return { kind: "OK", total };
}
