import { state, symbolIdFor, primaryRuntimes, defaultRuntime, RuntimeState } from "../../state";
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

// Parse and validate a manual-order string. `ctid` scopes the account-dependent
// checks (symbol availability, USD value, live mark) to THAT account's broker;
// undefined uses the default account for checks but the caller decides which
// runtimes execute on. Returns the parsed signal or a user-facing error.
function parseManualOrder(
  text: string,
  ctid?: number
): { signal?: ParsedSignal; isLimit: boolean; kind: string; error?: string } {
  const parts = text.trim().split(/\s+/);

  const direction = (parts[0] || "").toUpperCase();
  if (direction !== "BUY" && direction !== "SELL") return { isLimit: false, kind: "", error: USAGE };

  const symbol = (parts[1] || "").toUpperCase();
  if (!symbol) return { isLimit: false, kind: "", error: USAGE };

  // Numeric tail. Reject any non-numeric / non-positive token up front so a typo
  // never reaches the broker as a 0/NaN volume or price.
  const nums = parts.slice(2).map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
    return { isLimit: false, kind: "", error: `All values must be positive numbers.\n\n${USAGE}` };
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
    return { isLimit: false, kind: "", error: `Expected 3 values (market) or 4 (limit), got ${nums.length}.\n\n${USAGE}` };
  }

  // Only trade symbols the bot is configured for. Add it first.
  if (!state.settings.allowedSymbols.includes(symbol)) {
    return { isLimit: false, kind: "", error: `${symbol} is not in your allowed symbols. Add it with /symbols add ${symbol} first.` };
  }
  if (symbolIdFor(symbol, ctid) === undefined) {
    return { isLimit: false, kind: "", error: `${symbol} is not available on this broker.` };
  }
  // The position must be valuable in USD: USD-quoted directly, or non-USD with a
  // conversion pair (so floating P&L and the daily limits convert it correctly).
  if (!canValueInUsd(symbol, ctid)) {
    return { isLimit: false, kind: "", error: `${symbol} cannot be valued in USD (no conversion pair); doochybot cannot manage its risk and P&L.` };
  }

  // SL/TP must sit on the correct side of the entry. For a market order use the
  // live mark as the entry reference; if no quote has arrived yet, fall back to a
  // relative check (TP vs SL) and let the broker reject an impossible level.
  const ref = isLimit ? entry! : getMarkPrice(symbol, direction, ctid);
  const sideErr = validateSides(direction, ref, tp, sl);
  if (sideErr) return { isLimit: false, kind: "", error: sideErr };

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

  return { signal, isLimit, kind: isLimit ? `limit @ ${entry}` : "market" };
}

// Execute a parsed signal on the given runtimes, mirroring the reply format of
// the Telegram command. Returns one reply line per runtime set.
async function placeSignalOn(
  rts: RuntimeState[],
  signal: ParsedSignal,
  isLimit: boolean,
  entry: number | null
): Promise<string> {
  let ok = 0;
  const errs: string[] = [];
  for (const rt of rts) {
    try {
      const res = await executeSignal(rt, signal);
      if (res.ok) ok++;
      else errs.push(`${rt.ctid}: ${res.error ?? "unknown error"}`);
    } catch (e: any) {
      errs.push(`${rt.ctid}: ${e?.message ?? "exception"}`);
    }
  }
  const base = isLimit
    ? `Limit order resting: ${signal.direction} ${signal.symbol} ${signal.manualLots} lots @ ${entry} (SL ${signal.sl} / TP ${signal.tp}).`
    : `Filled: ${signal.direction} ${signal.symbol} ${signal.manualLots} lots (SL ${signal.sl} / TP ${signal.tp}).`;
  if (rts.length === 0) return "No traded account configured.";
  if (ok === rts.length) return base;
  if (ok > 0) return `${base} (${ok}/${rts.length} accounts OK, ${rts.length - ok} failed)\nFailed: ${errs.join("; ")}`;
  return `Order not placed: ${errs.join("; ") || "unknown error"}`;
}

export async function orderCmd(ctx: any) {
  const text: string = ctx.message?.text?.trim() ?? "";
  const p = parseManualOrder(text);
  if (p.error) {
    await ctx.reply(p.error);
    return;
  }
  const { signal, isLimit, kind } = p;
  if (!signal) return;

  await ctx.reply(`Placing ${signal.direction} ${signal.symbol} ${signal.manualLots} lots (${kind}), SL ${signal.sl} / TP ${signal.tp}...`);
  const reply = await placeSignalOn(primaryRuntimes(), signal, isLimit, isLimit ? signal.price : null);
  await ctx.reply(reply);
}

// Place a manual order scoped to ONE account (the mini-app's Trade tab): parse
// against that account's broker and execute on it alone. Returns the same
// display text the chat command would produce.
export async function placeManualOrderForAccount(
  args: string[],
  ctid?: number
): Promise<{ ok: boolean; text: string }> {
  const text = args.join(" ").trim();
  const p = parseManualOrder(text, ctid);
  if (p.error || !p.signal) return { ok: false, text: p.error || "Invalid order" };
  const rt = ctid !== undefined
    ? primaryRuntimes().find((r) => r.ctid === ctid)
    : undefined;
  const rts = rt ? [rt] : [defaultRuntime()];
  const reply = await placeSignalOn(rts, p.signal, p.isLimit, p.isLimit ? p.signal.price : null);
  return { ok: true, text: reply };
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
