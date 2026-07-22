import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Registry, REQUEST_TIMEOUT_MS } from "./registry";
import { requireAuth } from "./auth";
import { getUsers, setUserSettings } from "./db";
import { AgentMsg } from "./protocol";

// The Hub's HTTP + WebSocket surface, mirroring the routes the single-user bot
// exposes today (so the tunnel, channel-listener, and mini-app need no URL
// changes at cutover):
//   /app      static mini-app SPA
//   /api/*    per-user relays to the requesting user's agent
//   /webhook  channel-listener signals, forwarded to the owner's agent
//   /ws       agent WebSocket endpoint

// Same light shape check the bot's webhook applies, so garbage still gets a 400
// here instead of a round-trip to the agent. Full parsing (and the confidence
// default, which is an agent-side setting) stays in the agent.
const SIGNAL_SHAPE = /^(BUY|SELL)\s+\S+\s+(?:LIMIT=[\d.]+\s+)?SL=[\d.]+\s+TP=[\d.]+/i;

// Kill sockets that miss two ping rounds. Friends' PCs sleep without closing
// TCP cleanly; without this the registry would keep routing to a black hole
// until the OS finally times the connection out.
const WS_PING_INTERVAL_MS = 30_000;

function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function webappDist(): string {
  // dist/hub/server.js at runtime, src/hub/server.ts under tsx: repo root is
  // three levels up either way.
  return path.resolve(__dirname, "..", "..", "webapp", "dist");
}

// Relay one mini-app API call to the calling user's agent and translate the
// outcome to HTTP: 503 when the agent is offline or silent, 502 when the agent
// answered with an error, agent JSON otherwise.
async function relayApi(
  registry: Registry,
  userId: number,
  endpoint: string,
  params: Record<string, any>,
  res: express.Response
): Promise<void> {
  const socket = registry.socketFor(userId);
  if (!socket) {
    res.status(503).json({ error: "agent offline" });
    return;
  }
  try {
    const reply = await registry.request(socket, { type: "api", endpoint, params });
    if (!reply.ok) {
      res.status(502).json({ error: reply.error || "agent error" });
      return;
    }
    res.json(reply.data ?? {});
  } catch {
    res.status(503).json({ error: "agent offline or not responding" });
  }
}

// Relay a settings/command mutation to the user's agent via the cmd path (the
// same one Telegram uses), so the panel and the chat share one code path. The
// agent runs its existing handler and returns { text, settings }; we persist
// the settings snapshot and hand the panel back { text, settings } to refresh
// its forms. HTTP mapping matches relayApi: 503 offline, 502 agent error.
async function relayCommand(
  registry: Registry,
  userId: number,
  body: any,
  res: express.Response
): Promise<void> {
  const cmd = typeof body?.cmd === "string" ? body.cmd.trim() : "";
  const args = Array.isArray(body?.args) ? body.args.map((a: any) => String(a)) : [];
  if (!cmd) {
    res.status(400).json({ error: "cmd required" });
    return;
  }
  const socket = registry.socketFor(userId);
  if (!socket) {
    res.status(503).json({ error: "agent offline" });
    return;
  }
  try {
    // A command that builds a file (/export) can take longer than a normal
    // command's default timeout while it walks the broker's deal history, so
    // give the relay the same generous window the Telegram path uses.
    const timeout = cmd === "export" ? EXPORT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const reply = await registry.request(socket, { type: "cmd", cmd, args }, timeout);
    if (!reply.ok) {
      res.status(502).json({ error: reply.error || "agent error" });
      return;
    }
    if (reply.data?.settings) setUserSettings(userId, reply.data.settings);
    // Pass through a file the command produced (today only /export) so the
    // mini-app can offer it as a download.
    res.json({
      text: reply.data?.text ?? "OK",
      settings: reply.data?.settings ?? null,
      document: reply.data?.document ?? null,
    });
  } catch {
    res.status(503).json({ error: "agent offline or not responding" });
  }
}

// Matches the Telegram path's export budget: /export chunks weeks of deals in
// 7-day requests, which can outrun the normal per-request timeout.
const EXPORT_TIMEOUT_MS = 120_000;

export function startHubServer(registry: Registry, port: number): http.Server {
  const app = express();

  // ---- /api: per-user relays ------------------------------------------------
  const api = express.Router();
  api.use(express.json());
  api.use(requireAuth);

  // The user's last-known settings live in users.json and could be served even
  // with the agent offline, but every live route goes through the agent.
  api.get("/status", (req: any, res) => relayApi(registry, req.telegramUserId, "status", {}, res));
  api.get("/positions", (req: any, res) => relayApi(registry, req.telegramUserId, "positions", {}, res));
  api.get("/signals", (req: any, res) => relayApi(registry, req.telegramUserId, "signals", {}, res));
  api.get("/settings", (req: any, res) => relayApi(registry, req.telegramUserId, "settings", {}, res));
  // Manual-order panel: live prices for the selector, and the preview that turns
  // a size into a risk figure (or a risk into a size) before anything is placed.
  api.get("/quotes", (req: any, res) => relayApi(registry, req.telegramUserId, "quotes", {}, res));
  api.post("/order/preview", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "order_preview", req.body || {}, res));
  // Per-position actions from the expanded position card.
  api.post("/position/close", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "close_position", req.body || {}, res));
  api.post("/position/amend", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "amend_position", req.body || {}, res));
  // Resting LIMIT/STOP orders awaiting fill, and the per-order cancel.
  api.get("/orders/pending", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "pending_orders", {}, res));
  api.post("/order/cancel", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "cancel_order", req.body || {}, res));
  api.post("/order/amend", (req: any, res) =>
    relayApi(registry, req.telegramUserId, "amend_order", req.body || {}, res));
  api.post("/pause", (req: any, res) => relayApi(registry, req.telegramUserId, "pause", {}, res));
  api.post("/resume", (req: any, res) => relayApi(registry, req.telegramUserId, "resume", {}, res));
  api.post("/closeall", (req: any, res) => relayApi(registry, req.telegramUserId, "closeall", {}, res));

  // Generic command relay: the mini-app's settings panel POSTs { cmd, args }
  // and it runs through the very same agent handler a Telegram command would,
  // so the two surfaces can never drift. The agent's reply carries the display
  // text and a fresh settings snapshot, which we persist as the last-known copy
  // (mirroring bot.ts's relay()). userId comes from the authenticated socket,
  // never the body.
  api.post("/command", (req: any, res) => relayCommand(registry, req.telegramUserId, req.body, res));
  app.use("/api", api);

  // ---- /app: static mini-app (unchanged from the single-user server) ---------
  const dist = webappDist();
  if (fs.existsSync(dist)) {
    app.use("/app", express.static(dist));
    app.get("/app/{*splat}", (_req, res) => {
      res.sendFile(path.join(dist, "index.html"));
    });
    console.log(`[HUB] Serving mini-app UI from ${dist} at /app`);
  } else {
    console.warn(`[HUB] Mini-app build not found at ${dist}; /app will 404`);
  }

  // ---- /webhook: channel-listener signals, forwarded to the owner's agent ----
  const webhookSecret = process.env.WEBHOOK_SECRET || "";
  if (!webhookSecret) {
    console.warn("[HUB] No WEBHOOK_SECRET set; /webhook is unauthenticated");
  }

  app.post("/webhook", express.text({ type: "*/*" }), async (req, res) => {
    if (webhookSecret && !secretEquals(req.get("X-Webhook-Secret") || "", webhookSecret)) {
      console.log("[HUB] /webhook rejected: missing/invalid secret");
      return res.status(401).send("Unauthorized");
    }
    const body = typeof req.body === "string" ? req.body.trim() : "";
    const source = (req.get("X-Signal-Source") || "Channel").trim() || "Channel";
    console.log(`[HUB] Signal received (${source}): ${JSON.stringify(body)}`);

    if (!SIGNAL_SHAPE.test(body)) {
      return res.status(400).send("Could not parse signal");
    }

    // Fan the signal out to EVERY connected agent; each user's own risk gate,
    // symbol list, and pause state decide what to do with it. Users never run
    // the channel-listener themselves: this hub-side broadcast is how channel
    // signals reach them.
    const users = getUsers();
    const targets = registry.connectedUserIds()
      .map((userId) => ({ userId, socket: registry.socketFor(userId)! }))
      .filter((t) => t.socket);
    if (targets.length === 0) {
      console.warn("[HUB] No agents online; signal dropped");
      return res.status(503).send("No agents online");
    }

    const results = await Promise.all(targets.map(async ({ userId, socket }) => {
      const name = users[String(userId)]?.name || String(userId);
      try {
        const reply = await registry.request(socket, { type: "signal", text: body, source }, REQUEST_TIMEOUT_MS);
        return `${name}: ${reply.data?.text || (reply.ok ? "accepted" : `rejected: ${reply.error || "unknown"}`)}`;
      } catch {
        return `${name}: agent not responding`;
      }
    }));

    console.log(`[HUB] Signal fanned out to ${targets.length} agent(s)`);
    // 200 regardless of individual outcomes, same contract as the old
    // endpoint; the body carries the per-user results for the listener's log.
    return res.status(200).send(results.join("\n"));
  });

  // Everything else is a flat 404, same explicit surface as the old server.
  app.use((_req, res) => {
    res.status(404).send("Not found");
  });

  // ---- HTTP + WebSocket on one port ------------------------------------------
  // Loopback only, exactly like the old server: agents on other machines reach
  // /ws through the Cloudflare tunnel; Agent-San connects to loopback directly.
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (socket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    socket.on("message", (raw) => {
      let msg: AgentMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        return;
      }
      const reply = registry.handleMessage(socket, msg);
      if (reply) socket.send(JSON.stringify(reply));
    });

    socket.on("close", () => registry.release(socket));
    socket.on("error", () => socket.close());
  });

  const pinger = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate(); // close event fires and releases the binding
        continue;
      }
      alive.set(socket, false);
      try { socket.ping(); } catch { /* terminated below on next round */ }
    }
  }, WS_PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(pinger));

  server.listen(port, "127.0.0.1", () => {
    console.log(`[HUB] Listening on http://127.0.0.1:${port} (/app, /api, /webhook, /ws)`);
  });

  return server;
}

// Persist a settings snapshot an agent included in a cmd response, as the
// last-known copy for offline mini-app display. Exposed here so bot.ts stays
// free of db imports it does not otherwise need.
export function persistSettingsSnapshot(userId: number, settings: unknown): void {
  if (settings && typeof settings === "object") {
    setUserSettings(userId, settings as Record<string, any>);
  }
}
