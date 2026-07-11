import { state, symbolIdFor } from "../state";

// Live mark prices straight from cTrader's spot stream. This is the ONLY
// real-time price source we have — the HTTP signal feed only updates a symbol
// when an alert for it fires, so it's stale/absent for P&L. ProtoOAReconcileReq
// returns the ENTRY price, not the mark. So for accurate floating P&L (and the
// profit cap's realized+floating check) we keep a persistent spot subscription
// for every symbol we hold a position in.

let connection: any = null;

// symbolId → latest { bid, ask } in real price units (already de-scaled).
interface Quote { bid: number; ask: number; time: number; }
const quotes = new Map<number, Quote>();

// symbolIds we've already asked the broker to stream.
const subscribed = new Set<number>();

// symbolIds we've already logged a first quote for — diagnostic only, so the
// logs prove whether spot events actually arrive for a held symbol (vs. the
// subscribe silently succeeding but no data streaming).
const loggedFirstQuote = new Set<number>();

// ProtoOASpotEvent bid/ask are integers in 1/100000 of a price unit.
const SPOT_SCALE = 100_000;

export function setLivePriceConnection(conn: any): void {
  connection = conn;

  conn.on("ProtoOASpotEvent", (event: any) => {
    const data = event.descriptor ?? event;
    const symId = Number(data.symbolId);
    if (!symId) return;

    const prev = quotes.get(symId) ?? { bid: 0, ask: 0, time: 0 };
    // Spot events only carry whichever side changed; keep the other side.
    const bid = data.bid != null ? Number(data.bid) / SPOT_SCALE : prev.bid;
    const ask = data.ask != null ? Number(data.ask) / SPOT_SCALE : prev.ask;
    quotes.set(symId, { bid, ask, time: Date.now() });

    // Diagnostic: confirm in the logs that spot data is actually streaming for a
    // symbol. If a position is open but this line never appears for its symbolId,
    // the broker isn't pushing spots despite the subscribe succeeding.
    if (!loggedFirstQuote.has(symId)) {
      loggedFirstQuote.add(symId);
      console.log(`[SPOT] First quote for symbol ${symId}: bid=${bid} ask=${ask}`);
    }
  });
}

// Forget which symbolIds we've told the broker to stream. A reconnect opens a new
// socket and the broker forgets every subscription, so this must be called before
// re-subscribing — otherwise subscribeSpots skips ids still in `subscribed` and no
// spot data flows on the new connection (leaving floating P&L and sizing blind).
export function resetSpotSubscriptions(): void {
  subscribed.clear();
}

// Subscribe to spot updates for the given symbolIds (idempotent). Safe to call
// repeatedly — already-subscribed ids are skipped.
export async function subscribeSpots(symbolIds: number[]): Promise<void> {
  if (!connection) return;
  const fresh = symbolIds.filter((id) => id && !subscribed.has(id));
  if (!fresh.length) return;
  try {
    await connection.sendCommand("ProtoOASubscribeSpotsReq", {
      ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
      symbolId: fresh,
    });
    fresh.forEach((id) => subscribed.add(id));
    console.log(`[SPOT] Subscribed to ${fresh.length} symbol(s): ${fresh.join(",")}`);
  } catch (err: any) {
    // ALREADY_SUBSCRIBED means the broker already streams these — that's a
    // success for our purposes. Cache them so we stop re-sending every call
    // (capMonitor/subscribeOpenPositions run this repeatedly).
    if (err.errorCode === "ALREADY_SUBSCRIBED") {
      fresh.forEach((id) => subscribed.add(id));
      console.log(`[SPOT] Already subscribed to ${fresh.join(",")} — cached`);
      return;
    }
    console.warn(`[SPOT] Subscribe failed for ${fresh.join(",")}: ${err.errorCode || err.message || "request failed"}`);
  }
}

// Ensure every symbol with an open position is being streamed. Call on boot
// (after reconcile) and whenever a new position opens.
export async function subscribeOpenPositions(): Promise<void> {
  const ids = [...new Set(
    [...state.positions.values()]
      .map((p) => symbolIdFor(p.symbol))
      .filter((id): id is number => id !== undefined)
  )];
  await subscribeSpots(ids);
}

// Mark price for closing a position of the given direction:
//   BUY  closes at the bid (you sell to close)
//   SELL closes at the ask (you buy to close)
// This matches how cTrader computes the "Net USD" figure shown in the UI.
export function getMarkPrice(symbol: string, direction: "BUY" | "SELL"): number | null {
  const symId = symbolIdFor(symbol);
  if (symId === undefined) return null;
  // quotes is keyed by Number(symbolId); coerce defensively so a stray string
  // symbolId can never silently miss the lookup (the bug that zeroed floating P&L).
  const q = quotes.get(Number(symId));
  if (!q) return null;
  const price = direction === "BUY" ? q.bid : q.ask;
  return price > 0 ? price : null;
}

// Has a live quote for this symbol arrived yet?
export function hasLiveQuote(symbol: string): boolean {
  const symId = symbolIdFor(symbol);
  if (symId === undefined) return false;
  return quotes.has(Number(symId));
}

// ---------------------------------------------------------------------------
// Quote-currency -> USD conversion
//
// The money model ($PnL = priceDiff * volumeCents / 100) produces a figure in the
// symbol's QUOTE currency. For a USD-quoted symbol that is already USD; for a
// JPY/CAD-quoted one (GBPJPY, USDCAD, ...) it must be multiplied by the quote
// currency's USD value. We read that rate live from the broker's spot stream on
// the matching conversion pair (USDJPY, USDCAD, ...) and cache the last-known
// value so a momentary gap in the stream never nulls a valuation.
// ---------------------------------------------------------------------------

// Last successfully-read conversion factor per conversion-pair symbol name. FX
// rates move slowly, so a cached value is a safe stand-in for a missed tick.
const lastRate = new Map<string, number>();

// Mid price (average of bid/ask, or whichever side we have) for a symbol. Used
// for currency conversion, where a direction-neutral rate is wanted.
function getMidPrice(symbol: string): number | null {
  const symId = symbolIdFor(symbol);
  if (symId === undefined) return null;
  const q = quotes.get(Number(symId));
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  const one = q.bid > 0 ? q.bid : q.ask;
  return one > 0 ? one : null;
}

// The broker symbol whose spot gives `symbol`'s quote-currency-to-USD rate, or
// null if `symbol` is USD-quoted (no conversion needed) or no USD pair exists for
// its quote currency. For quote currency Q we prefer USD+Q (e.g. USDJPY) and fall
// back to Q+USD (e.g. EURUSD). Note USDCAD/USDJPY are their own conversion pair.
export function conversionSymbolFor(symbol: string): string | null {
  const quote = state.symbolQuote.get(symbol) ?? state.symbolQuote.get(symbol.replace(/USD$/, ""));
  if (!quote || quote === "USD") return null;
  const usdQ = `USD${quote}`;
  if (symbolIdFor(usdQ) !== undefined) return usdQ;
  const qUsd = `${quote}USD`;
  if (symbolIdFor(qUsd) !== undefined) return qUsd;
  return null;
}

// Multiplier that converts an amount in `symbol`'s QUOTE currency into USD.
//   - USD-quoted symbol  -> 1 (identical arithmetic to before this existed).
//   - convertible non-USD -> the live (or last-known) conversion factor.
//   - non-USD with no available rate AND nothing cached -> null; callers refuse
//     to size or value the position rather than use a wrong number.
// Fails open to 1 only when NO asset data has loaded at all (symbolQuote empty),
// matching the pre-existing degraded behaviour of isUsdQuoted.
export function quoteToUsd(symbol: string): number | null {
  if (state.symbolQuote.size === 0) return 1;
  const quote = state.symbolQuote.get(symbol) ?? state.symbolQuote.get(symbol.replace(/USD$/, ""));
  if (!quote || quote === "USD") return 1;

  const convSym = conversionSymbolFor(symbol);
  if (!convSym) return null;

  const mid = getMidPrice(convSym);
  if (mid && mid > 0) {
    // USDJPY-style pair: USD is the base, so 1 unit of quote = 1/mid USD.
    // EURUSD-style pair (quote is the base): 1 unit of quote = mid USD.
    const factor = convSym.startsWith("USD") ? 1 / mid : mid;
    lastRate.set(convSym, factor);
    return factor;
  }
  const cached = lastRate.get(convSym);
  return cached ?? null;
}

// Whether `symbol` can be valued in USD IN PRINCIPLE: USD-quoted, or non-USD with
// a conversion pair on this broker. Independent of whether the rate has streamed
// yet (unlike quoteToUsd, which returns null until a rate is available). Use this
// for static "is this tradeable at all" decisions (the entry gate, /symbols add,
// reconcile adoption); use quoteToUsd for the actual valuation/sizing at trade time.
export function canValueInUsd(symbol: string): boolean {
  if (state.symbolQuote.size === 0) return true; // no asset data loaded -> fail open
  const quote = state.symbolQuote.get(symbol) ?? state.symbolQuote.get(symbol.replace(/USD$/, ""));
  if (!quote || quote === "USD") return true;
  return conversionSymbolFor(symbol) !== null;
}

// Subscribe the USD conversion pairs needed to value the given symbols in USD, so
// a rate is already streaming (warm) before the first non-USD trade or valuation.
// USD-quoted symbols contribute nothing. Idempotent (subscribeSpots dedupes).
export async function subscribeConversionPairs(symbols: string[]): Promise<void> {
  const ids = [...new Set(
    symbols
      .map((s) => conversionSymbolFor(s))
      .filter((s): s is string => s !== null)
      .map((s) => symbolIdFor(s))
      .filter((id): id is number => id !== undefined)
  )];
  if (ids.length) await subscribeSpots(ids);
}
