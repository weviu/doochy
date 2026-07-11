/**
 * Signal extraction for the SureShot Gold channel.
 *
 * The channel posts a single trade across several messages. A signal begins with
 * a line like:
 *
 *     XAUUSD SELL LIMIT 4345.82
 *
 * and is only complete once both an `SL: <price>` and a `TP: <price>` line have
 * been seen. Everything in between (signatures, blank lines, dashes) is noise and
 * is ignored. The parser buffers messages from the start line until SL and TP are
 * both found, then emits the finished signal.
 *
 * Trade-management / promotional messages (CLOSE PARTIAL, MOVE SL TO ENTRY, VIP
 * offers, "running in profit", etc.) are filtered out by keyword before any
 * buffering happens. Handling those as a real feature is left for later.
 */

export interface Signal {
  symbol: string;
  direction: "BUY" | "SELL";
  // "LIMIT" -> a pending entry the bot should place as a resting limit order at
  // `entry`. "MARKET" -> fill immediately (entry is informational only, and may
  // be null for channels that do not provide one, e.g. fxoro).
  orderType: "MARKET" | "LIMIT";
  entry: number | null;
  sl: number;
  tp: number;
}

// Words that mark a message as trade-management or promo noise. If any appears
// (case-insensitive) the whole message is skipped — never buffered.
const NOISE_KEYWORDS = ["CLOSE", "PIPS", "VIP", "MOVE SL", "PROFIT", "RUNNING"];

// Start of a new signal: symbol + direction (+ optional LIMIT) + entry price.
// The symbol is captured rather than assumed, so a future format change is
// picked up automatically even though today it is always XAUUSD. Group 3 is the
// optional "LIMIT" keyword — present means a resting limit order at the price.
const START_RE = /\b([A-Z]{3,8})\s+(BUY|SELL)(\s+LIMIT)?\s+(\d+(?:\.\d+)?)/i;
const SL_RE = /\bSL\s*[:=]?\s*(\d+(?:\.\d+)?)/i;
const TP_RE = /\bTP\s*[:=]?\s*(\d+(?:\.\d+)?)/i;

// Discard an incomplete buffer if the channel goes quiet for this long.
const BUFFER_TIMEOUT_MS = 30_000;

interface Buffer {
  symbol: string;
  direction: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  entry: number;
  sl: number | null;
  tp: number | null;
}

export class SignalParser {
  private buffer: Buffer | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Feed one channel message in. Returns a finished Signal once direction,
   * entry, SL and TP have all been collected; otherwise null.
   */
  processMessage(text: string): Signal | null {
    if (!text) return null;

    // 1. Noise filter — applies to the whole message, before any buffering.
    if (this.isNoise(text)) {
      return null;
    }

    // 2. A new start line always wins: it discards any incomplete buffer in
    //    progress and begins a fresh one.
    const start = text.match(START_RE);
    if (start) {
      this.buffer = {
        symbol: start[1].toUpperCase(),
        direction: start[2].toUpperCase() as "BUY" | "SELL",
        orderType: start[3] ? "LIMIT" : "MARKET",
        entry: parseFloat(start[4]),
        sl: null,
        tp: null,
      };
      this.armTimeout();
      // The signal may be fully contained in this one message, so fall through
      // and scan it for SL/TP below.
    }

    // 3. Nothing to add to without an active buffer.
    if (!this.buffer) return null;

    // 4. Refresh the inactivity timeout on every message we keep buffering.
    this.armTimeout();

    // 5. Collect SL / TP from the relevant lines, ignoring signatures and dashes.
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("--")) continue; // "--Trade by ..." signature

      const sl = line.match(SL_RE);
      if (sl) this.buffer.sl = parseFloat(sl[1]);

      const tp = line.match(TP_RE);
      if (tp) this.buffer.tp = parseFloat(tp[1]);
    }

    // 6. Emit once all four values are present.
    if (this.buffer.sl !== null && this.buffer.tp !== null) {
      const signal: Signal = {
        symbol: this.buffer.symbol,
        direction: this.buffer.direction,
        orderType: this.buffer.orderType,
        entry: this.buffer.entry,
        sl: this.buffer.sl,
        tp: this.buffer.tp,
      };
      this.reset();
      return signal;
    }

    return null;
  }

  private isNoise(text: string): boolean {
    const upper = text.toUpperCase();
    return NOISE_KEYWORDS.some((kw) => upper.includes(kw));
  }

  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.buffer) {
        console.warn("[parser] Incomplete signal buffer timed out — discarding");
      }
      this.reset();
    }, BUFFER_TIMEOUT_MS);
    // Don't keep the process alive just for this timer.
    this.timer.unref?.();
  }

  private reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = null;
  }
}
