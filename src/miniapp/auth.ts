import crypto from "crypto";

// Validate a Telegram Mini App initData string per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// The signature proves the payload came from Telegram (signed with our bot
// token) and identifies the user. We then check that user id against the same
// ALLOWED_USERS list the command bot uses, so the web UI has identical access
// control to the chat commands.

let botToken = "";
let allowedUsers: number[] = [];

export function initMiniAppAuth(token: string, users: number[]): void {
  botToken = token;
  allowedUsers = users.filter((n) => !isNaN(n) && n !== 0);
}

// Max age of an initData signature we will accept, to blunt replay of a captured
// string. Telegram refreshes it as the Mini App runs, so a day is generous.
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

  // Data-check-string: every field except `hash`, sorted by key, as key=value
  // lines joined by \n.
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time compare; guard against length mismatch which timingSafeEqual throws on.
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

  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    return { ok: false, reason: "unauthorized" };
  }

  return { ok: true, userId };
}

// Express middleware: pull initData from the Authorization header (the SPA sends
// `Authorization: tma <initData>`) or an X-Telegram-Init-Data header, validate it,
// and 401 on any failure.
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
