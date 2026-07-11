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
    source: "Signal-scanner",
    // Scanner tag ("gold_scanner", ...); scopes the news-calendar guard + time exit.
    signalSource: alert.signal_source,
    // Optional per-signal time-based exit (minutes from fill); scoped/clamped later.
    timeExitMin: alert.time_exit_min ?? null,
  };
}