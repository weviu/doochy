import express from "express";
import crypto from "crypto";
import { ParsedSignal } from "./signals/types";
import { processSignal } from "./risk/gate";
import { state } from "./state";
import { mountMiniApp } from "./miniapp/api";

const PORT = 9009;

// Constant-time string equality for the webhook secret, so a mismatch can't be
// probed by timing. Returns false on any length mismatch (timingSafeEqual throws
// otherwise).
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Parse DoochyBot's plain-text signal format into a ParsedSignal:
 *
 *     BUY XAUUSD SL=4300.2 TP=4345.82               (market — fills now)
 *     SELL XAUUSD LIMIT=4329 SL=4350 TP=4300        (limit  — rests until 4329)
 *
 * This is the format the channel-listener POSTs. Fields the feed carries but
 * this format doesn't (rsi, price, confidence, etc.) are defaulted — market
 * orders size from the live mark price; SL/TP/LIMIT here are absolute prices the
 * order pipeline applies directly. The optional LIMIT=<price> selects a resting
 * limit order at that price; without it the signal is a market order.
 */
export function parseTextSignal(text: string, source: string): ParsedSignal | null {
  const m = text.trim().match(/^(BUY|SELL)\s+(\S+)\s+(?:LIMIT=([\d.]+)\s+)?SL=([\d.]+)\s+TP=([\d.]+)/i);
  if (!m) return null;

  const limitPrice = m[3] !== undefined ? parseFloat(m[3]) : undefined;
  const sl = parseFloat(m[4]);
  const tp = parseFloat(m[5]);
  if (Number.isNaN(sl) || Number.isNaN(tp)) return null;
  if (limitPrice !== undefined && Number.isNaN(limitPrice)) return null;

  return {
    symbol: m[2].toUpperCase(),
    direction: m[1].toUpperCase() as "BUY" | "SELL",
    rsi: 0,
    price: 0,
    pivotLevel: null,
    pivotDistance: null,
    // Channel/webhook signals carry no confidence of their own. They are
    // analyst-curated, so assign a configurable default (/risk confidence) rather
    // than 0, which would lose every reversal tie-break against an open position.
    confidence: state.settings.webhookConfidence,
    timeframe: "",
    timestamp: new Date().toISOString(),
    sl,
    tp,
    orderType: limitPrice !== undefined ? "LIMIT" : "MARKET",
    limitPrice,
    source,
  };
}

/**
 * Start the localhost-only HTTP server that lets the channel-listener push
 * time-sensitive signals straight into the same gate/execution path the poller
 * uses, instead of waiting for the next 10s poll.
 */
export function startWebhookServer(): void {
  const app = express();

  // The Mini App API/UI now share this server (the Cloudflare tunnel forwards
  // 9009). Mount it BEFORE the /webhook text parser so /api gets JSON bodies.
  mountMiniApp(app);

  // Shared-secret guard for /webhook. Because this server is now reachable
  // through the Cloudflare tunnel, an unauthenticated /webhook would let anyone
  // on the internet inject trades. When WEBHOOK_SECRET is set we require the
  // channel-listener's X-Webhook-Secret header to match. It is left optional only
  // so an operator who hasn't rolled the secret to the listener yet isn't broken
  // by a silent change; set it in production. Tunnel ingress should also be
  // restricted to /app and /api as defence in depth.
  const webhookSecret = process.env.WEBHOOK_SECRET || "";
  if (!webhookSecret) {
    console.warn("[WEBHOOK] No WEBHOOK_SECRET set. /webhook is unauthenticated; set WEBHOOK_SECRET (and match it in the channel-listener) and restrict the tunnel to /app and /api.");
  }

  // Text body parser scoped to /webhook only (the API needs JSON, parsed by its
  // own router).
  app.post("/webhook", express.text({ type: "*/*" }), (req, res) => {
    if (webhookSecret && !secretEquals(req.get("X-Webhook-Secret") || "", webhookSecret)) {
      console.log("[WEBHOOK] Rejected: missing/invalid secret");
      return res.status(401).send("Unauthorized");
    }
    const body = typeof req.body === "string" ? req.body : "";
    // The channel-listener labels each POST with the channel title; default to a
    // generic "Channel" if the header is absent (e.g. a manual curl).
    const source = (req.get("X-Signal-Source") || "Channel").trim() || "Channel";
    console.log(`[WEBHOOK] Received (${source}): ${JSON.stringify(body)}`);

    const signal = parseTextSignal(body, source);
    if (!signal) {
      console.log("[WEBHOOK] Rejected: could not parse signal");
      return res.status(400).send("Could not parse signal");
    }

    const result = processSignal(signal);
    if (!result.accepted) {
      return res.status(200).send(`Signal rejected: ${result.reason ?? "unknown reason"}`);
    }
    return res.status(200).send(`Signal accepted: ${signal.direction} ${signal.symbol} executing`);
  });

  // Explicit surface: the ONLY reachable routes are /webhook (secret-gated),
  // /api/* (Telegram initData gated, mounted above) and /app (static UI). Anything
  // else — root, probes, stray paths — gets a flat 404. This must be the last
  // handler registered so it only catches what nothing above matched.
  app.use((_req, res) => {
    res.status(404).send("Not found");
  });

  // Bind to loopback only. Public reach comes solely via the Cloudflare tunnel
  // forwarding to 127.0.0.1:9009; the process itself never listens on a public
  // interface.
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[WEBHOOK] Listening on http://127.0.0.1:${PORT} (/webhook, /api, /app)`);
  });
}
