import crypto from "crypto";
import { isKnownUser } from "./db";

// Telegram Mini App initData validation for the Hub, mirroring
// src/miniapp/auth.ts but with two differences: the signing key is the HUB
// bot's token (the mini-app will be attached to the Hub bot at cutover), and
// the whitelist is users.json instead of the ALLOWED_USERS env.

let botToken = "";

export function initHubAuth(token: string): void {
  botToken = token;
}

const MAX_AGE_SEC = 24 * 60 * 60;

export interface AuthResult {
  ok: boolean;
  userId?: number;
  reason?: string;
}

export function validateInitData(initData: string): AuthResult {
  if (!initData) return { ok: false, reason: "missing initData" };
  if (!botToken) return { ok: false, reason: "auth not initialised" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) {
    return { ok: false, reason: "expired" };
  }

  let userId: number | undefined;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    userId = Number(user.id);
  } catch {
    return { ok: false, reason: "bad user" };
  }
  if (!userId) return { ok: false, reason: "no user id" };

  if (!isKnownUser(userId)) return { ok: false, reason: "unauthorized" };

  return { ok: true, userId };
}

// Express middleware: same header contract as the existing mini-app
// (`Authorization: tma <initData>` or X-Telegram-Init-Data).
export function requireAuth(req: any, res: any, next: any): void {
  const auth = String(req.get("authorization") || "");
  const fromAuth = auth.toLowerCase().startsWith("tma ") ? auth.slice(4) : "";
  const initData = fromAuth || req.get("x-telegram-init-data") || "";

  const result = validateInitData(initData);
  if (!result.ok) {
    res.status(401).json({ error: `unauthorized: ${result.reason}` });
    return;
  }
  req.telegramUserId = result.userId;
  next();
}
