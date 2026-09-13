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
  // Null when the signal has no RSI to report. Scanner alerts always carry one;
  // spotware_copy alerts (a human clicking an Autochartist entry) have no
  // indicator behind them, so they emit null rather than a fabricated number.
  // Display only - nothing in the bot gates or computes on this value.
  rsi: number | null;
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
  // The trade size the copy source actually traded, carried on spotware_copy
  // alerts only (see CopyAlert in copytrade/alertsFile.ts for the full
  // semantics). volume_cents is the AUTHORITATIVE sizing quantity (physical
  // size, identical across brokers); lots is the source broker's lot label for
  // the same size (display only — lot numbers are broker-relative); source_risk_usd
  // is the source trade's dollar risk at its settled SL, so a consumer can
  // approximate its own copy risk as source_risk_usd × its size ratio. All are
  // absent/null on scanner and other non-copy alerts ("no size info").
  volume_cents?: number | null;
  lots?: number | null;
  source_risk_usd?: number | null;
}

export interface ParsedSignal {
  symbol: string;
  direction: "BUY" | "SELL";
  // Null when the source has no RSI (see RawAlert.rsi). Channel and manual orders
  // historically set 0 here for the same "not applicable" case; null is the
  // honest spelling, and 0 is a real RSI value (maximally oversold).
  rsi: number | null;
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
  // report it (webhook). Informational only: shown in the signal log and in
  // notifications. Never gates entries, sizing, or order placement.
  btcState?: BtcState | null;
  // The trade size a copy source actually traded, carried from spotware_copy
  // alerts (RawAlert.volume_cents / lots / source_risk_usd). When volumeCents is
  // present (> 0) AND the executing account has copySizeRatio set (> 0), the
  // order is sized to volumeCents × ratio instead of risk-based sizing — the
  // consumer reproduces the source trade at the user's chosen multiple. lots is
  // the SOURCE broker's lot label for the same size and is display-only (a lot
  // number is meaningless on a different broker: each sets its own lotSize).
  // sourceRiskUSD lets the gate and notifications state the trade's intended
  // dollar risk (source risk × ratio) without re-deriving it. Absent for all
  // non-copy signals, which continue to be risk-sized.
  volumeCents?: number | null;
  lots?: number | null;
  sourceRiskUSD?: number | null;
}