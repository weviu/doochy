import { ParsedSignal } from "./signals/types";
import { state } from "./state";

// Signal-format parsing only. The HTTP server that used to live here (webhook +
// mini-app on port 9009) belonged to the retired single-user entrypoint; the Hub
// owns that port and serves /webhook, /api, /app and /ws itself (src/hub/server.ts).
// The agent reaches the parser via the Hub's WS relay (src/doochybot/handlers.ts).

/**
 * Parse DoochyBot's plain-text signal format into a ParsedSignal:
 *
 *     BUY XAUUSD SL=4300.2 TP=4345.82               (market — fills now)
 *     SELL XAUUSD LIMIT=4329 SL=4350 TP=4300        (limit  — rests until 4329)
 *
 * This is the format the channel-listener POSTs. Fields the feed carries but
 * this format doesn't (rsi, price, confidence, etc.) are defaulted — market
 * orders size from the live mark price; SL/TP/LIMIT here are absolute prices the
 * order pipeline applies directly. The optional LIMIT=<price> selects a resting
 * limit order at that price; without it the signal is a market order.
 */
export function parseTextSignal(text: string, source: string): ParsedSignal | null {
  const m = text.trim().match(/^(BUY|SELL)\s+(\S+)\s+(?:LIMIT=([\d.]+)\s+)?SL=([\d.]+)\s+TP=([\d.]+)/i);
  if (!m) return null;

  const limitPrice = m[3] !== undefined ? parseFloat(m[3]) : undefined;
  const sl = parseFloat(m[4]);
  const tp = parseFloat(m[5]);
  if (Number.isNaN(sl) || Number.isNaN(tp)) return null;
  if (limitPrice !== undefined && Number.isNaN(limitPrice)) return null;

  return {
    symbol: m[2].toUpperCase().replace(/USDT$/, "USD"),
    direction: m[1].toUpperCase() as "BUY" | "SELL",
    rsi: 0,
    price: 0,
    pivotLevel: null,
    pivotDistance: null,
    // Channel/webhook signals carry no confidence of their own. They are
    // analyst-curated, so assign a configurable default (/risk confidence) rather
    // than 0, which would lose every reversal tie-break against an open position.
    confidence: state.settings.webhookConfidence,
    timeframe: "",
    timestamp: new Date().toISOString(),
    sl,
    tp,
    orderType: limitPrice !== undefined ? "LIMIT" : "MARKET",
    limitPrice,
    source,
  };
}
