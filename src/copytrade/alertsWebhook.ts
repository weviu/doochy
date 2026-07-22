import express from "express";
import crypto from "crypto";
import { prependAlert, CopyAlert } from "./alertsFile";
import { alreadyWritten, markWritten } from "./writtenPositions";

// Receives copy-trade alerts over HTTP and writes them into alerts.json, so the
// machine that SEES an Autochartist fill (a friend's trading box) need not be the
// machine that HOSTS the feed. The sender POSTs the fill facts; this endpoint owns
// the actual write, which is what keeps dedup and same-second collision handling
// correct even when several senders push at once.
//
// Deployment mirrors the existing webhook (src/webhook.ts): bind to loopback and
// let nginx / a tunnel provide the only public path in. The process never listens
// on a public interface itself.

// 9011 by default: the hub uses 9010, the legacy webhook 9009, so this stays
// clear of both. Override with COPYTRADE_WEBHOOK_PORT.
const PORT = Number(process.env.COPYTRADE_WEBHOOK_PORT || 9011);

// Shared secret. Required: without it the endpoint would let anyone inject an
// alert that every user's bot may auto-execute. Refuse to start open.
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// The wire payload the sender transmits: the fill facts plus the position id for
// dedup. Timestamps and collision handling are the receiver's job, so they are
// NOT sent.
export interface CopyAlertPayload {
  positionId: number;
  symbol: string;
  direction: "buy" | "sell";
  price: number;
  sl: number | null;
  tp: number | null;
  signal_source: string;
}

// Strict validation: anything that isn't a well-formed alert is rejected before
// it can reach the feed every user polls. Returns an error string, or null when
// the body is valid.
function validate(body: any): string | null {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  if (!Number.isFinite(Number(body.positionId))) return "positionId must be a number";
  if (typeof body.symbol !== "string" || !body.symbol.trim()) return "symbol must be a non-empty string";
  if (body.direction !== "buy" && body.direction !== "sell") return "direction must be 'buy' or 'sell'";
  if (!Number.isFinite(Number(body.price))) return "price must be a number";
  if (body.sl != null && !Number.isFinite(Number(body.sl))) return "sl must be a number or null";
  if (body.tp != null && !Number.isFinite(Number(body.tp))) return "tp must be a number or null";
  // signal_source is the ONLY field distinguishing this from a scanner alert, and
  // downstream filtering depends entirely on it. Never accept a write without it.
  if (typeof body.signal_source !== "string" || !body.signal_source.trim()) return "signal_source is required";
  return null;
}

export function startCopyAlertWebhook(): void {
  const secret = (process.env.COPYTRADE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.error("[COPY-HOOK] COPYTRADE_WEBHOOK_SECRET is not set; refusing to start an unauthenticated trade-injection endpoint");
    return;
  }

  const app = express();

  app.post("/copy-alert", express.json({ limit: "16kb" }), (req, res) => {
    if (!secretEquals(req.get("X-Webhook-Secret") || "", secret)) {
      console.log("[COPY-HOOK] Rejected: missing/invalid secret");
      return res.status(401).send("Unauthorized");
    }

    const err = validate(req.body);
    if (err) {
      console.log(`[COPY-HOOK] Rejected: ${err}`);
      return res.status(400).send(`Invalid alert: ${err}`);
    }
    const payload = req.body as CopyAlertPayload;
    const positionId = Number(payload.positionId);

    // Dedup here, where the file is written: a sender restart (or a second sender
    // for the same account) must not produce a duplicate. Persisted across restart
    // by writtenPositions.
    if (alreadyWritten(positionId)) {
      console.log(`[COPY-HOOK] Position #${positionId} already written; acknowledging without re-writing`);
      // 200, not an error: the sender did its job, the alert simply already exists.
      return res.status(200).send("Already recorded");
    }

    const fields: Omit<CopyAlert, "timestamp" | "timestamp_local"> = {
      symbol: payload.symbol,
      // Copy-trade fills carry no chart interval (see sourceWatcher). Kept null.
      timeframe: null,
      direction: payload.direction,
      rsi: null,
      price: Number(payload.price),
      current_price: Number(payload.price),
      pivot_level: null,
      pivot_distance: null,
      confidence: 100.0,
      sl: payload.sl != null ? Number(payload.sl) : null,
      tp: payload.tp != null ? Number(payload.tp) : null,
      time_exit_min: null,
      src_bar: null,
      btc_state: null,
      signal_source: payload.signal_source,
    };

    try {
      const { written, bumpedBy } = prependAlert(fields, new Date());
      markWritten(positionId);
      const bumpNote = bumpedBy > 0 ? ` (bumped ${bumpedBy}s to avoid a same-second collision)` : "";
      console.log(`[COPY-HOOK] Wrote ${payload.direction.toUpperCase()} ${payload.symbol} @ ${payload.price} (SL ${fields.sl ?? "none"} / TP ${fields.tp ?? "none"}) from position #${positionId} -> alert ${written}${bumpNote}`);
      return res.status(200).send(`Recorded: alert ${written}`);
    } catch (e: any) {
      console.error(`[COPY-HOOK] FAILED to write alert for position #${positionId}: ${e.message}`);
      return res.status(500).send("Could not write alert");
    }
  });

  // Everything else is a flat 404, so probes and stray paths reveal nothing.
  app.use((_req, res) => res.status(404).send("Not found"));

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[COPY-HOOK] Listening on http://127.0.0.1:${PORT}/copy-alert (secret-gated)`);
  });
}
