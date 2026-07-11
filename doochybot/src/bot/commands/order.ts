import { state, symbolIdFor } from "../../state";
import { ParsedSignal } from "../../signals/types";
import { executeSignal } from "../../ctrader/orders";
import { getMarkPrice, canValueInUsd } from "../../ctrader/livePrices";

// Place a trade by typing it straight into the chat. Bypasses the signal gate
// (allowed-symbol membership aside) — it's a manual override sized to the exact
// lots you type, with absolute SL/TP prices.
//
//   Market: SELL <symbol> <lots> <TP> <SL>
//   Limit:  SELL <symbol> <lots> <entry> <TP> <SL>
//
// Market vs limit is decided by the count of numbers: 3 = market, 4 = limit.
const USAGE =
  "Manual order:\n" +
  "Market: BUY|SELL <symbol> <lots> <TP> <SL>\n" +
  "Limit:  BUY|SELL <symbol> <lots> <entry> <TP> <SL>\n" +
  "e.g. SELL XAUUSD 0.02 3950 4010\n" +
  "e.g. BUY XAUUSD 0.02 4000 4050 3960";

export async function orderCmd(ctx: any) {
  const text: string = ctx.message?.text?.trim() ?? "";
  const parts = text.split(/\s+/);

  const direction = (parts[0] || "").toUpperCase();
  if (direction !== "BUY" && direction !== "SELL") {
    await ctx.reply(USAGE);
    return;
  }

  const symbol = (parts[1] || "").toUpperCase();
  if (!symbol) {
    await ctx.reply(USAGE);
    return;
  }

  // Numeric tail. Reject any non-numeric / non-positive token up front so a typo
  // never reaches the broker as a 0/NaN volume or price.
  const rawNums = parts.slice(2);
  const nums = rawNums.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
    await ctx.reply(`All values must be positive numbers.\n\n${USAGE}`);
    return;
  }

  let lots: number;
  let entry: number | null;
  let tp: number;
  let sl: number;
  let isLimit: boolean;
  if (nums.length === 3) {
    [lots, tp, sl] = nums;
    entry = null;
    isLimit = false;
  } else if (nums.length === 4) {
    [lots, entry, tp, sl] = nums;
    isLimit = true;
  } else {
    await ctx.reply(`Expected 3 values (market) or 4 (limit), got ${nums.length}.\n\n${USAGE}`);
    return;
  }

  // Only trade symbols the bot is configured for. Add it first.
  if (!state.settings.allowedSymbols.includes(symbol)) {
    await ctx.reply(`${symbol} is not in your allowed symbols. Add it with /symbols add ${symbol} first.`);
    return;
  }
  if (symbolIdFor(symbol) === undefined) {
    await ctx.reply(`${symbol} is not available on this broker.`);
    return;
  }
  // The position must be valuable in USD: USD-quoted directly, or non-USD with a
  // conversion pair (so floating P&L and the daily limits convert it correctly).
  if (!canValueInUsd(symbol)) {
    await ctx.reply(`${symbol} cannot be valued in USD (no conversion pair); doochybot cannot manage its risk and P&L.`);
    return;
  }

  // SL/TP must sit on the correct side of the entry. For a market order use the
  // live mark as the entry reference; if no quote has arrived yet, fall back to a
  // relative check (TP vs SL) and let the broker reject an impossible level.
  const ref = isLimit ? entry! : getMarkPrice(symbol, direction);
  const sideErr = validateSides(direction, ref, tp, sl);
  if (sideErr) {
    await ctx.reply(sideErr);
    return;
  }

  const signal: ParsedSignal = {
    symbol,
    direction,
    rsi: 0,
    price: ref ?? 0,
    pivotLevel: null,
    pivotDistance: null,
    // High confidence so a later feed signal's reversal logic won't auto-flip a
    // position you placed by hand (it flips only on >= confidence).
    confidence: 100,
    timeframe: "manual",
    timestamp: new Date().toISOString(),
    sl,
    tp,
    source: "Manual",
    manualLots: lots,
    ...(isLimit ? { orderType: "LIMIT" as const, limitPrice: entry! } : { orderType: "MARKET" as const }),
  };

  const kind = isLimit ? `limit @ ${entry}` : "market";
  await ctx.reply(`Placing ${direction} ${symbol} ${lots} lots (${kind}), SL ${sl} / TP ${tp}...`);

  try {
    const res = await executeSignal(signal);
    if (res.ok) {
      await ctx.reply(
        isLimit
          ? `Limit order resting: ${direction} ${symbol} ${lots} lots @ ${entry} (SL ${sl} / TP ${tp}).`
          : `Filled: ${direction} ${symbol} ${lots} lots (SL ${sl} / TP ${tp}).`
      );
    } else {
      await ctx.reply(`Order not placed: ${res.error ?? "unknown error"}`);
    }
  } catch (err: any) {
    await ctx.reply(`Order failed: ${err?.message ?? "unknown error"}`);
  }
}

// Returns an error message if SL/TP are on the wrong side, otherwise null.
function validateSides(
  direction: "BUY" | "SELL",
  ref: number | null,
  tp: number,
  sl: number
): string | null {
  if (direction === "BUY") {
    if (tp <= sl) return `For a BUY, TP (${tp}) must be above SL (${sl}).`;
    if (ref != null) {
      if (tp <= ref) return `For a BUY, TP (${tp}) must be above the entry (~${ref}).`;
      if (sl >= ref) return `For a BUY, SL (${sl}) must be below the entry (~${ref}).`;
    }
  } else {
    if (tp >= sl) return `For a SELL, TP (${tp}) must be below SL (${sl}).`;
    if (ref != null) {
      if (tp >= ref) return `For a SELL, TP (${tp}) must be below the entry (~${ref}).`;
      if (sl <= ref) return `For a SELL, SL (${sl}) must be above the entry (~${ref}).`;
    }
  }
  return null;
}
