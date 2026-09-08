import { state, symbolIdFor, quoteCurrencyFor, RuntimeState } from "../state";
import { sendWhere, envForAccount, connectionFor } from "./environments";
import { primaryAccountId } from "./accounts";

// Live mark prices straight from cTrader's spot stream. This is the ONLY
// real-time price source we have — the HTTP signal feed only updates a Symbol
// when an alert for it fires, so it's stale/absent for P&L. ProtoOAReconcileReq
// returns the ENTRY price, not the mark. So for accurate floating P&L (and the
// profit cap's realized+floating check) we keep a persistent spot subscription
// for every symbol we hold a position in.
//
// Multi-environment/account: a spot event carries no ctidTraderAccountId, but it
// does arrive on a specific environment's socket, and each environment is a
// distinct broker host. Quotes are therefore keyed by "${env}:${symbolId}"
// (symbol ids can collide across hosts, and only the environment we asked is
// guaranteed to be streaming). Subscriptions are issued PER ACCOUNT
// (ProtoOASubscribeSpotsReq is account-scoped), so the "already subscribed"
// bookkeeping is keyed by "${env}:${symbolId}".

// The account a no-ctid call acts on (the first primary). Trading-path callers
// pass rt.ctid so each account reads its own broker's stream.
function defaultCtid(): number {
  return primaryAccountId();
}

// symbolId → latest { bid, ask } in real price units (already de-scaled), scoped
// to the environment that streams them.
interface Quote { bid: number; ask: number; time: number; }
const quotes = new Map<string, Quote>();

// "${env}:${symbolId}" pairs we've already asked the broker to stream.
const subscribed = new Set<string>();

// pairs we've already logged a first quote for — diagnostic only, so the logs
// prove whether spot events actually arrive for a held symbol (vs. the
// subscribe silently succeeding but no data streaming).
const loggedFirstQuote = new Set<string>();

// ProtoOASpotEvent bid/ask are integers in 1/100000 of a price unit.
const SPOT_SCALE = 100_000;

const quoteKey = (env: string, symbolId: number): string => `${env}:${symbolId}`;

export function setLivePriceConnection(env: string, conn: any): void {
  conn.on("ProtoOASpotEvent", (event: any) => {
    const data = event.descriptor ?? event;
    const symId = Number(data.symbolId);
    if (!symId) return;
    const key = quoteKey(env, symId);

    const prev = quotes.get(key) ?? { bid: 0, ask: 0, time: 0 };
    // Spot events only carry whichever side changed; keep the other side.
    const bid = data.bid != null ? Number(data.bid) / SPOT_SCALE : prev.bid;
    const ask = data.ask != null ? Number(data.ask) / SPOT_SCALE : prev.ask;
    quotes.set(key, { bid, ask, time: Date.now() });

    // Diagnostic: confirm in the logs that spot data is actually streaming. If a
    // position is open but this line never appears for its pair, the broker isn't
    // pushing spots despite the subscribe succeeding.
    if (!loggedFirstQuote.has(key)) {
      loggedFirstQuote.add(key);
      console.log(`[SPOT] First quote for ${key}: bid=${bid} ask=${ask}`);
    }
  });
}

// Forget which pairs we've told ONE environment's broker to stream. A reconnect
// opens a new socket and the broker forgets every subscription on it, so this
// must be called before re-subscribing that environment — otherwise
// subscribeSpots skips pairs still in `subscribed` and no spot data flows on the
// new connection.
export function resetSpotSubscriptions(env: string): void {
  for (const key of subscribed) {
    if (key.startsWith(`${env}:`)) subscribed.delete(key);
  }
}

// Subscribe to spot updates for the given symbolIds on ONE account (idempotent).
// Safe to call repeatedly — already-subscribed pairs are skipped.
export async function subscribeSpots(rt: RuntimeState, symbolIds: number[]): Promise<void> {
  const env = envForAccount(rt.ctid);
  if (!env || !connectionFor(env)) return;
  const fresh = symbolIds.filter((id) => id && !subscribed.has(quoteKey(env, id)));
  if (!fresh.length) return;
  try {
    await sendWhere("ProtoOASubscribeSpotsReq", {
      ctidTraderAccountId: rt.ctid,
      symbolId: fresh,
    });
    fresh.forEach((id) => subscribed.add(quoteKey(env, id)));
    console.log(`[SPOT] Subscribed account ${rt.ctid} (${env}) to ${fresh.length} symbol(s): ${fresh.join(",")}`);
  } catch (err: any) {
    // ALREADY_SUBSCRIBED means the broker already streams these — that's a
    // success for our purposes. Cache them so we stop re-sending every call
    // (capMonitor/subscribeOpenPositions run this repeatedly).
    if (err.errorCode === "ALREADY_SUBSCRIBED") {
      fresh.forEach((id) => subscribed.add(quoteKey(env, id)));
      console.log(`[SPOT] Account ${rt.ctid} (${env}) already subscribed to ${fresh.join(",")} — cached`);
      return;
    }
    console.warn(`[SPOT] Subscribe failed for account ${rt.ctid} (${env}) on ${fresh.join(",")}: ${err.errorCode || err.message || "request failed"}`);
  }
}

// Ensure every symbol with an open position on ONE account is being streamed.
// Call on boot (after reconcile) and whenever a new position opens.
export async function subscribeOpenPositions(rt: RuntimeState): Promise<void> {
  const ids = [...new Set(
    [...rt.positions.values()]
      .map((p) => symbolIdFor(p.symbol, rt.ctid))
      .filter((id): id is number => id !== undefined)
  )];
  await subscribeSpots(rt, ids);
}

// Mark price for closing a position of the given direction:
//   BUY  closes at the bid (you sell to close)
//   SELL closes at the ask (you buy to close)
// This matches how cTrader computes the "Net USD" figure shown in the UI.
export function getMarkPrice(symbol: string, direction: "BUY" | "SELL", ctid?: number): number | null {
  const target = ctid ?? defaultCtid();
  const env = envForAccount(target);
  const symId = env ? symbolIdFor(symbol, target) : undefined;
  if (env === undefined || symId === undefined) return null;
  // quotes is keyed by Number(symbolId); coerce defensively so a stray string
  // symbolId can never silently miss the lookup (the bug that zeroed floating P&L).
  const q = quotes.get(quoteKey(env, Number(symId)));
  if (!q) return null;
  const price = direction === "BUY" ? q.bid : q.ask;
  return price > 0 ? price : null;
}

// The raw two-sided quote, for display (the mini-app's price header shows bid,
// ask and the spread). getMarkPrice picks a side for valuation; this exposes
// both without duplicating the symbolId/coercion handling.
export function getQuote(symbol: string, ctid?: number): { bid: number; ask: number; time: number } | null {
  const target = ctid ?? defaultCtid();
  const env = envForAccount(target);
  const symId = env ? symbolIdFor(symbol, target) : undefined;
  if (env === undefined || symId === undefined) return null;
  const q = quotes.get(quoteKey(env, Number(symId)));
  return q ? { bid: q.bid, ask: q.ask, time: q.time } : null;
}

// Has a live quote for this symbol arrived yet?
export function hasLiveQuote(symbol: string, ctid?: number): boolean {
  const target = ctid ?? defaultCtid();
  const env = envForAccount(target);
  const symId = env ? symbolIdFor(symbol, target) : undefined;
  if (env === undefined || symId === undefined) return false;
  return quotes.has(quoteKey(env, Number(symId)));
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
function getMidPrice(symbol: string, ctid: number): number | null {
  const env = envForAccount(ctid);
  const symId = env ? symbolIdFor(symbol, ctid) : undefined;
  if (env === undefined || symId === undefined) return null;
  const q = quotes.get(quoteKey(env, Number(symId)));
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  const one = q.bid > 0 ? q.bid : q.ask;
  return one > 0 ? one : null;
}

// The broker symbol whose spot gives `symbol`'s quote-currency-to-USD rate on ONE
// account, or null if `symbol` is USD-quoted (no conversion needed) or no USD
// pair exists for its quote currency. For quote currency Q we prefer USD+Q (e.g.
// USDJPY) and fall back to Q+USD (e.g. EURUSD). Note USDCAD/USDJPY are their own
// conversion pair.
export function conversionSymbolFor(symbol: string, ctid?: number): string | null {
  const target = ctid ?? defaultCtid();
  const quote = quoteCurrencyFor(symbol, target);
  if (!quote || quote === "USD") return null;
  const usdQ = `USD${quote}`;
  if (symbolIdFor(usdQ, target) !== undefined) return usdQ;
  const qUsd = `${quote}USD`;
  if (symbolIdFor(qUsd, target) !== undefined) return qUsd;
  return null;
}

// Multiplier that converts an amount in `symbol`'s QUOTE currency into USD on
// ONE account.
//   - USD-quoted symbol  -> 1 (identical arithmetic to before this existed).
//   - convertible non-USD -> the live (or last-known) conversion factor.
//   - non-USD with no available rate AND nothing cached -> null; callers refuse
//     to size or value the position rather than use a wrong number.
// Fails open to 1 only when NO asset data has loaded at all (quote map empty),
// matching the pre-existing degraded behaviour of isUsdQuoted.
export function quoteToUsd(symbol: string, ctid?: number): number | null {
  const target = ctid ?? defaultCtid();
  const quote = quoteCurrencyFor(symbol, target);
  if (quote === undefined && state.accountSymbols.has(target)) return 1; // symbol loaded but no quote data
  if (!quote || quote === "USD") return 1;

  const convSym = conversionSymbolFor(symbol, target);
  if (!convSym) return null;

  const mid = getMidPrice(convSym, target);
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

// Whether `symbol` can be valued in USD IN PRINCIPLE on ONE account: USD-quoted,
// or non-USD with a conversion pair on this broker. Independent of whether the
// rate has streamed yet (unlike quoteToUsd, which returns null until a rate is
// available). Use this for static "is this tradeable at all" decisions (the entry
// gate, /symbols add, reconcile adoption); use quoteToUsd for the actual
// valuation/sizing at trade time.
export function canValueInUsd(symbol: string, ctid?: number): boolean {
  const target = ctid ?? defaultCtid();
  if (state.accountSymbols.get(target)?.quote.size === 0) return true; // no asset data loaded -> fail open
  const quote = quoteCurrencyFor(symbol, target);
  if (!quote || quote === "USD") return true;
  return conversionSymbolFor(symbol, target) !== null;
}

// Subscribe the USD conversion pairs needed to value the given symbols in USD on
// ONE account, so a rate is already streaming (warm) before the first non-USD
// trade or valuation. USD-quoted symbols contribute nothing. Idempotent
// (subscribeSpots dedupes).
export async function subscribeConversionPairs(rt: RuntimeState, symbols: string[]): Promise<void> {
  const ids = [...new Set(
    symbols
      .map((s) => conversionSymbolFor(s, rt.ctid))
      .filter((s): s is string => s !== null)
      .map((s) => symbolIdFor(s, rt.ctid))
      .filter((id): id is number => id !== undefined)
  )];
  if (ids.length) await subscribeSpots(rt, ids);
}