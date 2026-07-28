import { Signal } from "../parser";

// Parser for the WORLD FAMOUS TRADER channel. Like fxoro (and unlike SureShot)
// every signal is self-contained in one message, so no buffering is needed.
// The current format is:
//
//   XAUUSD SELL 4052/4055
//
//   TP1. @ 4050
//   TP2. @ 4048
//   ...
//   TP6. @ 4035
//
//   SL     @ 4062
//
// The two numbers after the direction are an entry ZONE, not a single price
// ("sell somewhere between 4052 and 4055"). Across the whole message history the
// second number is always the edge further in the direction that improves the
// fill — higher for SELL, lower for BUY. We deliberately ignore both and send a
// market order: the zone's far edge only fills if price first moves against the
// trade, and older messages in this channel have shown corrupt far-edge values
// (e.g. "Entry: 4453 - 4557" on a SELL). Entry is therefore null, exactly as the
// fxoro parser does, and DoochyBot fills at the current market price.
//
// Only the FIRST take-profit is used; TP2..TP6 are ignored by design.
//
// The channel also posts result/hype messages that mention a direction, e.g.
// "XAUUSD_SELL\n\nTP1 HIT 20+PIPS BOOM BOOM" or "GOLD SELL\n\nRUNNING IN 50+
// PIPS". Those carry no entry zone and no SL, so requiring the full shape below
// filters them out without needing a keyword blocklist.

// Start line: symbol, direction, then the "a/b" entry zone. Anchored to a line
// start so a direction mentioned mid-sentence in a hype message can't match.
// Separators seen in this channel's signals are "/" and "_"; both are accepted.
const START_RE = /^\s*([A-Z]{3,10})\s+(BUY|SELL)\s+(\d+(?:\.\d+)?)\s*[/_]\s*(\d+(?:\.\d+)?)/im;

// First take-profit only. Matches "TP1. @ 4050", "TP1 4050", "TP1: 4050".
const TP1_RE = /\bTP\s*1\b\D*(\d+(?:\.\d+)?)/i;

// Stop loss. Matches "SL     @ 4062", "SL: 4062", "SL 4062".
const SL_RE = /\bSL\b\s*[:@]?\s*(\d+(?:\.\d+)?)/i;

export function parseWftSignal(text: string): Signal | null {
  if (!text) return null;

  const start = text.match(START_RE);
  if (!start) return null;

  const tp1 = text.match(TP1_RE);
  const sl = text.match(SL_RE);
  if (!tp1 || !sl) return null;

  const tpNum = parseFloat(tp1[1]);
  const slNum = parseFloat(sl[1]);
  if (Number.isNaN(tpNum) || Number.isNaN(slNum)) return null;

  const direction = start[2].toUpperCase() === "BUY" ? "BUY" : "SELL";

  // Sanity check: SL must sit on the losing side of TP1 for the direction. A
  // message that fails this is malformed (the channel has posted transposed
  // numbers before) and is dropped rather than traded on.
  const consistent = direction === "BUY" ? slNum < tpNum : slNum > tpNum;
  if (!consistent) {
    console.warn(
      `[wft] Dropping inconsistent signal: ${direction} SL=${slNum} TP1=${tpNum} ` +
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
