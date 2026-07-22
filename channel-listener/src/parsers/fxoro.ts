import { Signal } from "../parser";

// Parser for the fxoro channel. Unlike SureShot, each signal is self-contained
// in one message with clearly labeled fields, so no multi-message buffering is
// needed. Example message (emoji and the long explanation are ignored):
//
//   Trading Signal
//   Symbol: BTCUSD
//   Direction: Buy
//   Stop-Loss Level: 63201.74
//   Take-Profit Level: 63870.37
//   Let me explain: ...
//   Start trading: @fxoro_global_bot
//
// Only the four labeled fields matter. The regexes match the label text and
// ignore any leading emoji. This channel gives no entry price, so entry is null
// and DoochyBot treats it as a market order at the current price.

const SYMBOL_RE = /Symbol:\s*([A-Za-z0-9]+)/i;
const DIRECTION_RE = /Direction:\s*(Buy|Sell)/i;
const SL_RE = /Stop-?Loss(?:\s*Level)?:\s*(\d+(?:\.\d+)?)/i;
const TP_RE = /Take-?Profit(?:\s*Level)?:\s*(\d+(?:\.\d+)?)/i;

export function parseFxoroSignal(text: string): Signal | null {
  // Only treat messages that carry the Symbol label as signals.
  if (!text || !/Symbol:/i.test(text)) return null;

  const sym = text.match(SYMBOL_RE);
  const dir = text.match(DIRECTION_RE);
  const sl = text.match(SL_RE);
  const tp = text.match(TP_RE);
  if (!sym || !dir || !sl || !tp) return null;

  const slNum = parseFloat(sl[1]);
  const tpNum = parseFloat(tp[1]);
  if (Number.isNaN(slNum) || Number.isNaN(tpNum)) return null;

  return {
    symbol: sym[1].toUpperCase(),
    direction: dir[1].toLowerCase() === "buy" ? "BUY" : "SELL",
    orderType: "MARKET",
    entry: null,
    sl: slNum,
    tp: tpNum,
  };
}
