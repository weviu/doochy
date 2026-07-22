import { Signal } from "./parser";

function sanitizeHeaderValue(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 120) || "Channel";
}

/**
 * Forward a parsed signal to DoochyBot's webhook endpoint.
 *
 * The body is DoochyBot's standard plain-text format, e.g.:
 *
 *     BUY XAUUSD SL=4300.2 TP=4345.82            (market — fills now)
 *     SELL XAUUSD LIMIT=4329 SL=4350 TP=4300     (limit  — rests until 4329)
 *
 * Market orders omit the entry price (DoochyBot fills at the current market, as
 * with a feed signal). Limit orders carry LIMIT=<entry> so DoochyBot places a
 * resting limit order that fills only when price reaches the level.
 *
 * Fire-and-forget: a failed POST is logged and dropped. The channel never repeats
 * a signal, so retrying a stale entry would be worse than skipping it.
 */
export async function sendSignal(signal: Signal, webhookUrl: string, source: string): Promise<void> {
  const entryPart = signal.orderType === "LIMIT" ? `LIMIT=${signal.entry} ` : "";
  const body = `${signal.direction} ${signal.symbol} ${entryPart}SL=${signal.sl} TP=${signal.tp}`;

  const safeSource = sanitizeHeaderValue(source);

  // Shared secret that authenticates this POST to DoochyBot's now-public /webhook.
  // Must match WEBHOOK_SECRET in DoochyBot's .env; omitted only if unset locally.
  const secret = process.env.WEBHOOK_SECRET || "";
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
    "X-Signal-Source": safeSource,
  };
  if (secret) headers["X-Webhook-Secret"] = secret;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok) {
      console.error(`[webhook] POST failed: HTTP ${res.status} ${res.statusText} — body sent: "${body}"`);
      return;
    }

    console.log(`[webhook] Sent: "${body}" -> ${webhookUrl} (HTTP ${res.status})`);
  } catch (err) {
    console.error(`[webhook] POST error for "${body}":`, err instanceof Error ? err.message : err);
  }
}
