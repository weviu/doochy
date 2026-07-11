import { state } from "../state";
import { ParsedSignal } from "../signals/types";
import { notify } from "./notify";

// Notify on every incoming signal (whether or not the gate executes it), so the
// user can act on it manually when trading somewhere other than cTrader. Fires
// only when signalNotify is on and the signal scores at least
// signalNotifyMinConfidence. Independent of the execution path and the entry
// gate. Called once per signal at the top of the gate, before any rejection.
export function maybeNotifySignal(signal: ParsedSignal): void {
  if (!state.settings.signalNotify) return;

  const conf = signal.confidence ?? 0;
  if (conf < state.settings.signalNotifyMinConfidence) return;

  // Green orb for buys, red orb for sells, per request.
  const orb = signal.direction === "BUY" ? "\u{1F7E2}" : "\u{1F534}";

  // SL/TP to display: the signal's own levels (scanner/channel/manual), which are
  // what execution actually uses. A LIMIT enters at limitPrice, a STOP at its
  // trigger, otherwise the market price - used only to pick display precision.
  const entry = signal.orderType === "LIMIT" && signal.limitPrice != null ? signal.limitPrice
    : signal.orderType === "STOP" && signal.stopPrice != null ? signal.stopPrice
    : signal.price;
  const slP = signal.sl;
  const tpP = signal.tp;
  // Match SL/TP precision to the entry price's decimal places.
  const digits = ((entry ?? 0).toString().split(".")[1] || "").length || 2;
  const fmt = (n: number | undefined) => (n != null ? n.toFixed(digits) : "-");

  // Fields in the requested order, always present so every notification has the
  // same shape: symbol, confidence, direction, price, sl, tp, signal source.
  // The orb stays on the direction line as the colour cue.
  const lines = [
    signal.symbol,
    `Confidence: ${conf}`,
    `${orb} ${signal.direction}`,
    `Price: ${signal.price || "-"}`,
  ];
  // Scanner's spot at generation, for reference (shown only when it differs from
  // the intended entry above; doochybot's own live price drives execution).
  if (signal.currentPrice != null && signal.currentPrice !== signal.price) lines.push(`Spot at signal: ${signal.currentPrice}`);
  if (signal.orderType === "LIMIT" && signal.limitPrice != null) lines.push(`Limit: ${signal.limitPrice}`);
  if (signal.orderType === "STOP" && signal.stopPrice != null) lines.push(`Stop trigger: ${signal.stopPrice}`);
  lines.push(`SL: ${fmt(slP)}`);
  lines.push(`TP: ${fmt(tpP)}`);
  // BTC macro state, for crypto only. Null/absent (gold, silver, forex, indices)
  // omits the line entirely rather than showing a meaningless "n/a".
  if (signal.btcState) lines.push(`BTC: ${signal.btcState}`);
  lines.push(`Source: ${signal.source || "Unknown"}`);

  notify(lines.join("\n")).catch(() => {});
}
