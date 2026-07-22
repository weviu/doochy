import express from "express";
import path from "path";
import fs from "fs";
import { requireAuth } from "./auth";
import { getConnection, pauseTrading, resumeTrading, closeAll } from "./service";
import { getStatusData } from "../bot/commands/status";
import { getPositionsData } from "../bot/commands/positions";

// Where the built Vite SPA lives. Built by `pnpm --dir webapp build` into
// webapp/dist and committed/deployed alongside the compiled bot. Resolved from
// the repo root (two levels up from dist/miniapp at runtime, or src/miniapp in dev).
function webappDist(): string {
  // At runtime this file is dist/miniapp/api.js -> repo root is ../../.
  // Under tsx (dev) it's src/miniapp/api.ts -> repo root is ../../ as well.
  return path.resolve(__dirname, "..", "..", "webapp", "dist");
}

// Build the /api router. All routes require a valid Telegram initData signature
// from an allowed user (requireAuth), so the web UI has the same access control
// as the chat commands.
export function miniAppApiRouter(): express.Router {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAuth);

  router.get("/status", async (_req, res) => {
    try {
      const data = await getStatusData(getConnection());
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "status failed" });
    }
  });

  router.get("/positions", (_req, res) => {
    try {
      res.json(getPositionsData());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "positions failed" });
    }
  });

  router.post("/pause", (_req, res) => {
    pauseTrading();
    res.json({ paused: true });
  });

  router.post("/resume", (_req, res) => {
    const { wasLocked } = resumeTrading();
    res.json({ paused: false, lockCleared: wasLocked });
  });

  router.post("/closeall", async (_req, res) => {
    try {
      const result = await closeAll();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "closeall failed" });
    }
  });

  return router;
}

// Mount the Mini App onto an existing Express app: the JSON API under /api and
// the static SPA under /app (with an SPA fallback so client-side routes work).
// Called from webhook.ts so it shares the single 9009 server the Cloudflare
// tunnel forwards to — no second port.
export function mountMiniApp(app: express.Express): void {
  app.use("/api", miniAppApiRouter());

  const dist = webappDist();
  if (!fs.existsSync(dist)) {
    console.warn(`[MINIAPP] Frontend build not found at ${dist} — run "pnpm --dir webapp build". API is live; UI will 404.`);
    return;
  }

  app.use("/app", express.static(dist));
  // SPA fallback: any /app/* path that isn't a real file serves index.html.
  app.get("/app/{*splat}", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
  console.log(`[MINIAPP] Serving UI from ${dist} at /app`);
}
