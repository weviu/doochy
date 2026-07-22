import { RawAlert, ParsedSignal } from "./types";

const SYMBOL_ALIASES: Record<string, string> = {
  AAVE: "AAVUSD",
  ALGO: "ALGUSD",
  AVAX: "AVAUSD",
  LINK: "LNKUSD",
  // Indices — map the feed's base name to the broker's exact symbol name.
  US30: "US 30",
  US500: "US 500",
  US100: "US TECH 100",
};

function resolveSymbol(raw: string): string | null {
  const upper = raw.toUpperCase();
  if (!upper.includes("/")) {
    // Already normalized (scanner output) — alias-check only, no USD append
    return SYMBOL_ALIASES[upper] ?? (upper || null);
  }
  const base = upper.split("/")[0];
  if (!base) return null;
  return SYMBOL_ALIASES[base] || `${base}USD`;
}

// Explicit labels for sources whose generated name would be wrong or unhelpful.
// Anything not listed falls through to the generic prettifier below, so a new
// scanner needs no change here to display sensibly.
const SOURCE_LABELS: Record<string, string> = {
  // Not a scanner: a real fill on the source account, copied. Worth saying so,
  // since "a person actually took this trade" is a different kind of evidence
  // from "an indicator crossed a threshold" when deciding whether to act.
  autochartist_copy: "Autochartist copy (live fill)",
};

// "gold_15m_scanner" -> "Gold 15m scanner". Keeps the feed's own naming rather
// than inventing one, so a source added later is readable with no code change.
function sourceLabel(signalSource: string | undefined): string {
  if (!signalSource) return "Signal-scanner"; // pre-tag alerts: unchanged label
  const explicit = SOURCE_LABELS[signalSource];
  if (explicit) return explicit;
  const pretty = signalSource.replace(/_/g, " ").trim();
  return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : "Signal-scanner";
}

export function parseSignal(alert: RawAlert): ParsedSignal | null {
  const symbol = resolveSymbol(alert.symbol);
  if (!symbol) return null;

  const dir = alert.direction.toUpperCase();
  if (dir !== "BUY" && dir !== "SELL") return null;

  return {
    symbol,
    direction: dir,
    rsi: alert.rsi,
    price: alert.price,
    // Spot at generation (reference/display only; not used to place orders).
    currentPrice: alert.current_price,
    pivotLevel: alert.pivot_level,
    pivotDistance: alert.pivot_distance,
    confidence: alert.confidence ?? 0,
    timeframe: alert.timeframe,
    timestamp: alert.timestamp,
    // The scanner's own SL/TP. Source of truth: they drive both placement and
    // risk-based sizing. A signal missing either is rejected at the gate.
    sl: alert.sl,
    tp: alert.tp,
    // BTC macro state for crypto (null for non-crypto, or absent on older alerts).
    btcState: alert.btc_state ?? null,
    // Human-facing origin label, derived from the feed's OWN signal_source tag.
    // Every alert states where it came from; hardcoding one label here discarded
    // that and made every feed signal read "Signal-scanner", so a copied real fill
    // was indistinguishable from a scanner's indicator firing.
    source: sourceLabel(alert.signal_source),
    // Scanner tag ("gold_scanner", ...); scopes the news-calendar guard + time exit.
    signalSource: alert.signal_source,
    // Optional per-signal time-based exit (minutes from fill); scoped/clamped later.
    timeExitMin: alert.time_exit_min ?? null,
  };
}