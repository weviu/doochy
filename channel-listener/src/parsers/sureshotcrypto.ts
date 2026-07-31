import { Signal } from "../parser";

// Parser for the SureShot Crypto channel (https://t.me/sureshotcypto). Like
// fxoro and wft (and unlike the multi-message SureShot gold parser) every signal
// is self-contained in one message:
//
//   🔴 XRPUSDT: SELL
//   Entry: 1.0911
//   =-=-=-=-=-=-=-=-=-=-=-=-=
//   SL :  1.1184  (-2.5%)
//   TP1:  1.0775  (+1.25%)
//   TP2:  1.0502  (+3.75%)
//   TP3:  1.0365  (+5%)
//   =-=-=-=-=-=-=-=-=-=-=-=-=
//   Leverage: 5-10x | Isolated
//
//   --Trade by Nas
//
// Only symbol, direction, SL and TP1 are read. The quoted "Entry" is ignored and
// the order is sent as MARKET — by the time the message reaches us price has
// usually moved off that level, and a resting limit at it only fills if price
// first goes against the trade. TP2/TP3 are ignored by design, as in wft.

// Start line: leading emoji is skipped, symbol then direction. The colon after
// the symbol is optional so a whitespace-separated variant still matches. The
// direction is anchored to the same line as the symbol so a direction mentioned
// in a later commentary line cannot be picked up.
const START_RE = /^[^A-Za-z0-9]*([A-Z0-9]{4,15})\s*:?\s+(BUY|SELL|LONG|SHORT)\b/im;

// First take-profit only. Matches "TP1:  1.0775", "TP1 1.0775", "TP1 @ 1.0775".
// The percentage in parentheses that follows is never reached by the match.
const TP1_RE = /\bTP\s*1\b\s*[:@=]?\s*(\d+(?:\.\d+)?)/i;

// Stop loss. Matches "SL :  1.1184", "SL: 1.1184", "SL 1.1184".
const SL_RE = /\bSL\b\s*[:@=]?\s*(\d+(?:\.\d+)?)/i;

export function parseSureshotCryptoSignal(text: string): Signal | null {
  if (!text) return null;

  const start = text.match(START_RE);
  if (!start) return null;

  const tp1 = text.match(TP1_RE);
  const sl = text.match(SL_RE);
  if (!tp1 || !sl) return null;

  const tpNum = parseFloat(tp1[1]);
  const slNum = parseFloat(sl[1]);
  if (!Number.isFinite(tpNum) || !Number.isFinite(slNum)) return null;

  const word = start[2].toUpperCase();
  const direction: "BUY" | "SELL" = word === "BUY" || word === "LONG" ? "BUY" : "SELL";

  // Sanity check: SL must sit on the losing side of TP1 for the direction. A
  // message that fails this has transposed numbers and is dropped rather than
  // traded on.
  const consistent = direction === "BUY" ? slNum < tpNum : slNum > tpNum;
  if (!consistent) {
    console.warn(
      `[sureshotcrypto] Dropping inconsistent signal: ${direction} SL=${slNum} TP1=${tpNum} ` +
      `(SL is on the wrong side of TP for a ${direction})`
    );
    return null;
  }

  return {
    symbol: start[1].toUpperCase(),
    direction,
    orderType: "MARKET",
    entry: null,
    sl: slNum,
    tp: tpNum,
  };
}
