// Dummy echo agent for testing the Hub without any trading code. Speaks the
// full agent protocol: pairs with a code, persists the minted token, re-auths
// with it on restart, answers cmd/api/signal requests with canned echoes, and
// sends one notify after connecting so the notification path gets exercised.
//
// Usage:
//   pnpm agent:dummy -- --code A1B2C3     first run: pair with a fresh code
//   pnpm agent:dummy                      later runs: auth with the saved token
//
// Env: HUB_WS_URL (default ws://127.0.0.1:9010/ws)

import fs from "fs";
import path from "path";
import WebSocket from "ws";

const HUB_WS_URL = process.env.HUB_WS_URL || "ws://127.0.0.1:9010/ws";
const TOKEN_FILE = path.join(process.cwd(), "data", "dummy-agent-token.json");

const codeArgIdx = process.argv.indexOf("--code");
const pairCode = codeArgIdx !== -1 ? process.argv[codeArgIdx + 1] : "";

function loadToken(): string {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")).token || "";
  } catch {
    return "";
  }
}

function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2));
}

// A BotSettings-shaped snapshot so the Hub's settings persistence can be
// verified end to end. Values are obviously fake.
const FAKE_SETTINGS = {
  allowedSymbols: ["BTCUSD", "XAUUSD"],
  riskPerTradeUSD: 47,
  maxPositions: 3,
  maxDailyLossUSD: 200,
  dummy: true,
};

let attempt = 0;

function connect(): void {
  attempt++;
  console.log(`[DUMMY] Connecting to ${HUB_WS_URL} (attempt ${attempt})`);
  const ws = new WebSocket(HUB_WS_URL);

  ws.on("open", () => {
    const token = loadToken();
    if (token) {
      console.log("[DUMMY] Authenticating with saved token");
      ws.send(JSON.stringify({ type: "auth", token }));
    } else if (pairCode) {
      console.log(`[DUMMY] Pairing with code ${pairCode}`);
      ws.send(JSON.stringify({ type: "pair", code: pairCode }));
    } else {
      console.error("[DUMMY] No saved token and no --code given. Run with: --code <code from /pair>");
      process.exit(1);
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log(`[DUMMY] <- ${JSON.stringify(msg)}`);

    switch (msg.type) {
      case "paired":
        saveToken(msg.token);
        console.log(`[DUMMY] Paired as user ${msg.userId}; token saved to ${TOKEN_FILE}`);
        ws.send(JSON.stringify({ type: "notify", message: "Dummy agent online (paired)" }));
        break;

      case "auth_ok":
        attempt = 0;
        console.log(`[DUMMY] Authenticated as user ${msg.userId}`);
        ws.send(JSON.stringify({ type: "notify", message: "Dummy agent online" }));
        break;

      case "cmd": {
        const data: any = { text: `echo: /${msg.cmd} ${msg.args.join(" ")}`.trim() };
        // A settings-changing command returns the full settings object, per the
        // protocol; include it so the Hub's users.json persistence is testable.
        if (msg.cmd === "risk" || msg.cmd === "settings") data.settings = FAKE_SETTINGS;
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, ok: true, data }));
        break;
      }

      case "api": {
        const canned: Record<string, any> = {
          status: { dummy: true, paused: false, balance: 10000 },
          positions: { positions: [] },
          pause: { paused: true },
          resume: { paused: false, lockCleared: false },
          closeall: { closed: 0, failed: 0, total: 0 },
        };
        const data = canned[msg.endpoint];
        ws.send(JSON.stringify(
          data
            ? { type: "response", requestId: msg.requestId, ok: true, data }
            : { type: "response", requestId: msg.requestId, ok: false, error: `unknown endpoint: ${msg.endpoint}` }
        ));
        break;
      }

      case "signal":
        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          ok: true,
          data: { text: `Signal accepted (dummy): ${msg.text} [${msg.source}]` },
        }));
        break;

      case "error":
        console.error(`[DUMMY] Hub error: ${msg.message}`);
        break;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[DUMMY] Disconnected (${code} ${reason.toString()}); reconnecting`);
    setTimeout(connect, Math.min(30_000, 2_000 * Math.max(1, attempt)));
  });

  ws.on("error", (err) => {
    console.error(`[DUMMY] Socket error: ${err.message}`);
    // close fires next and schedules the reconnect
  });
}

connect();
