// BTC's higher-timeframe macro state at the moment a signal fired, as decided by
// the feed's scanner. Crypto tracks BTC, so this drives the crypto suppression
// gate. Non-crypto instruments (gold, silver, forex, indices) carry null - the
// scanner already classified them, so we never infer crypto-ness ourselves.
export type BtcState =
  | "BULLISH_STRONG"
  | "BULLISH"
  | "NEUTRAL"
  | "BEARISH"
  | "BEARISH_STRONG";

export interface RawAlert {
  timestamp: string;
  symbol: string;
  timeframe: string;
  direction: string;
  rsi: number;
  price: number;
  // Spot price at the moment the scanner generated the signal. Reference only:
  // doochybot decides market-vs-limit at execution time against its OWN live
  // price, never this one (which is already stale by the time we consume it).
  current_price?: number;
  pivot_level: string | null;
  pivot_distance: number | null;
  confidence?: number;
  // The stop-loss and take-profit the scanner drew for this setup, off real
  // structure. Source of truth: they drive BOTH order placement AND risk-based
  // sizing (the position is sized so the entry-to-SL distance loses
  // ~riskPerTradeUSD). A signal missing either is rejected at the gate.
  sl?: number;
  tp?: number;
  signal_source?: string;
  // Optional per-signal time-based exit (wall-clock minutes from FILL). The gold
  // Connors-RSI strategy's edge is time-bounded, so a position opened from an alert
  // carrying this closes at market once its hold window elapses (SL/TP still armed;
  // whichever fires first wins). Present and > 0 activates it; absent/null means
  // "no time exit" and the position behaves exactly as today (SL/TP only). For a
  // time-exit signal `tp` may also be null (manage on SL + time only).
  time_exit_min?: number | null;
  // BTC macro state for crypto alerts; null for non-crypto. Optional too, so
  // alerts that predate this feed field parse as "not applicable" (same as null).
  btc_state?: BtcState | null;
}

export interface ParsedSignal {
  symbol: string;
  direction: "BUY" | "SELL";
  rsi: number;
  price: number;
  // Scanner's spot price at generation time (alert.current_price). Reference /
  // display only: the market-vs-limit decision uses our own live mark, not this.
  currentPrice?: number;
  pivotLevel: string | null;
  pivotDistance: number | null;
  confidence: number;
  timeframe: string;
  timestamp: string;
  // Absolute SL/TP price levels for this trade. For feed signals these are the
  // scanner's own levels (parser copies them straight from the alert); for channel
  // and manual orders they are the levels supplied in the message. They are the
  // source of truth for BOTH placement AND risk-based sizing (see executeSignal),
  // and a feed/channel signal missing either is rejected at the gate.
  sl?: number;
  tp?: number;
  // Order type. Absent → decided at execution time (executeSignal): channel and
  // manual orders set it explicitly, while feed/scanner signals leave it unset and
  // executeSignal picks MARKET / STOP / LIMIT by where signal.price (the target)
  // sits versus our live price (see ENTRY_TOLERANCE_PERCENT in orders.ts):
  //   target ≈ live               → MARKET (immediate fill)
  //   target the market must RISE → BUY buy-STOP  / SELL sell-LIMIT
  //   target the market must FALL → BUY buy-LIMIT / SELL sell-STOP
  // Both non-market legs rest at the target and fill only when price reaches it (no
  // fill, no trade if it never does) - "STOP" vs "LIMIT" is just the type the
  // exchange requires for that side; both are non-marketable so the fill lands at
  // ~price. limitPrice carries a LIMIT level, stopPrice a STOP trigger.
  orderType?: "MARKET" | "LIMIT" | "STOP";
  limitPrice?: number;
  // Trigger level for a STOP order. The order fills at ~stopPrice when the market
  // reaches it, so SL/TP anchored here stay on the correct side.
  stopPrice?: number;
  // Set only by a manual Telegram order (/order or a "BUY/SELL ..." chat message):
  // the exact lot size the user typed. When present, executeSignal uses this size
  // verbatim and skips risk-based sizing and the margin-aware cap — the user asked
  // for this size. sl/tp carry their absolute price levels. Absent for feed/channel
  // signals, which are always risk-sized.
  manualLots?: number;
  // Where the signal came from, for notifications: "Feed" for the RSI poller, or
  // the channel title for webhook signals from the channel-listener.
  source?: string;
  // The scanner's signal_source tag (alert.signal_source), e.g. "gold_scanner".
  // Distinct from `source` (the human-facing origin label): this is the machine
  // tag the news-calendar guard and the time-based exit scope on (in-scope =
  // gold_scanner + XAUUSD). Absent for channel/manual orders, no scanner tag.
  signalSource?: string;
  // Per-signal time-based exit in wall-clock minutes from fill (alert.time_exit_min).
  // Raw value from the feed; scoped to the configured symbols/sources and clamped to
  // maxTimeExitMin at execution time (see effectiveTimeExitMin). Absent/null/<=0 =>
  // no time exit (position managed on SL/TP only, exactly as today).
  timeExitMin?: number | null;
  // BTC macro state carried from the feed (alert.btc_state). Non-null only for
  // crypto; null/undefined means non-crypto or a signal source that doesn't
  // report it (webhook). Drives the crypto BTC-bias gate and is shown in
  // notifications. Never used for sizing or order placement.
  btcState?: BtcState | null;
}