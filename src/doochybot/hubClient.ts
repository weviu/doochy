import fs from "fs";
import path from "path";
import os from "os";
import WebSocket from "ws";
import { DATA_DIR } from "../paths";

// The agent's persistent WebSocket link to the Hub: pairs once with a /pair
// code, then authenticates with the minted long-lived token on every
// (re)connect. Reconnects forever with backoff; the trading engine keeps
// running regardless, only Hub-relayed commands and notifications wait.

const TOKEN_FILE = path.join(DATA_DIR, "doochybot-token.json");

// The Hub pings every 30s. If nothing at all arrives for three times that, the
// link is half-open (sleeping router, dead NAT entry) even though the socket
// looks OPEN; terminate so the reconnect loop rebuilds it.
const SILENCE_LIMIT_MS = 90_000;

export interface HubRequest {
  type: "cmd" | "api" | "signal";
  requestId: string;
  cmd?: string;
  args?: string[];
  endpoint?: string;
  params?: Record<string, any>;
  text?: string;
  source?: string;
}

export type RequestHandler = (msg: HubRequest) => Promise<{ ok: boolean; data?: any; error?: string }>;

// Whether a pairing token from a previous run exists, so the entrypoint can
// decide to prompt for a first-run pairing code.
export function hasSavedToken(): boolean {
  try {
    return !!JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")).token;
  } catch {
    return false;
  }
}

export class HubClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastActivity = Date.now();
  private silenceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private url: string,
    private pairCode: string,
    private onRequest: RequestHandler
  ) {}

  private loadToken(): string {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")).token || "";
    } catch {
      return "";
    }
  }

  private saveToken(token: string): void {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2));
  }

  start(): void {
    this.connect();
  }

  // Fire-and-forget notification to the Hub (fills, safety alerts). Dropped if
  // the link is down: the alert's trigger is logged locally either way, and a
  // stale alert delivered minutes later is worse than a missed one.
  notify(message: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "notify", message }));
    } else {
      console.log(`[HUB-LINK] Offline, notification dropped: ${message.split("\n")[0]}`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.attempt++;
    console.log(`[HUB-LINK] Connecting to ${this.url} (attempt ${this.attempt})`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      const token = this.loadToken();
      if (token) {
        ws.send(JSON.stringify({ type: "auth", token }));
      } else if (this.pairCode) {
        console.log("[HUB-LINK] No saved token; pairing with the provided code");
        ws.send(JSON.stringify({ type: "pair", code: this.pairCode, device: os.hostname() }));
      } else {
        console.error("[HUB-LINK] No saved token and no pair code. Get a code with /pair in Telegram and restart with AGENT_PAIR_CODE=<code> (or --code <code>).");
        this.stopped = true;
        ws.close();
      }
    });

    // Any inbound traffic (including the Hub's pings, surfaced as 'ping' by ws)
    // proves the link is alive.
    const touch = () => { this.lastActivity = Date.now(); };
    ws.on("ping", touch);
    ws.on("pong", touch);

    ws.on("message", async (raw) => {
      touch();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "paired":
          this.saveToken(msg.token);
          this.attempt = 0;
          console.log(`[HUB-LINK] Paired as user ${msg.userId}; token saved`);
          break;

        case "auth_ok":
          this.attempt = 0;
          console.log(`[HUB-LINK] Authenticated as user ${msg.userId}`);
          break;

        case "error":
          console.error(`[HUB-LINK] Hub error: ${msg.message}`);
          // Only an EXPLICIT revocation ("revoked": token unknown, or the user
          // was removed from the whitelist) may delete the saved token. Any
          // other error — including the hub's "retry" for a storage hiccup —
          // keeps the token and lets the reconnect loop try again. The old
          // regex on the message text treated every "invalid token" alike, so
          // a transient hub-side failure permanently destroyed the pairing.
          if (msg.code === "revoked") {
            try { fs.unlinkSync(TOKEN_FILE); } catch { /* nothing to drop */ }
            console.error("[HUB-LINK] Saved token revoked by the Hub and deleted. Re-pair with a fresh /pair code.");
            this.stopped = true;
            ws.close();
          } else if (msg.code === "bad_pair_code") {
            // Reconnecting would just resend the same dead code forever.
            console.error("[HUB-LINK] Pairing code rejected (invalid or expired). Get a fresh code with /pair and restart.");
            this.stopped = true;
            ws.close();
          }
          break;

        case "cmd":
        case "api":
        case "signal": {
          let result: { ok: boolean; data?: any; error?: string };
          try {
            result = await this.onRequest(msg as HubRequest);
          } catch (err: any) {
            result = { ok: false, error: err?.message || "handler failed" };
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, ...result }));
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
      if (this.stopped) return;
      const wait = Math.min(30_000, 2_000 * Math.max(1, this.attempt));
      console.log(`[HUB-LINK] Disconnected; retrying in ${wait / 1000}s`);
      setTimeout(() => this.connect(), wait);
    });

    ws.on("error", (err) => {
      console.warn(`[HUB-LINK] Socket error: ${err.message}`);
      // close fires next and schedules the reconnect
    });

    this.lastActivity = Date.now();
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > SILENCE_LIMIT_MS) {
        console.warn("[HUB-LINK] No traffic from the Hub; assuming a dead link and reconnecting");
        try { ws.terminate(); } catch { /* close handler reconnects */ }
      }
    }, 15_000);
  }
}
