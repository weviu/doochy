import * as fs from "fs";
import * as path from "path";
import { EnvName } from "./environments";

// cTrader access tokens expire (ProtoOARefreshTokenRes.expiresIn seconds). When
// the token behind the account session dies, the socket stays up and app-level
// pings keep passing, but every ACCOUNT-scoped request (reconcile, expected
// margin, new orders) starts failing — the bot looks "connected" yet silently
// stops trading. This module refreshes the access token using the refresh token
// and persists the rotated pair back to .env so a later refresh/restart uses the
// fresh tokens (the refresh token is single-use — it changes on every refresh).
//
// ONE token pair is shared across every environment: a cTrader app token
// authenticates on all hosts, and generating a second pair would invalidate the
// first. So the pair is always written back as the flat ACCESS_TOKEN / REFRESH_TOKEN
// variables, never folded into per-environment CTRADER_CREDENTIALS entries.

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

// Exchange the refresh token for a fresh access token (and a rotated refresh
// token). Runs on an app-authenticated connection; independent of account auth.
// Throws if the response carries no tokens (caller keeps the existing pair).
export async function refreshAccessToken(connection: any, refreshToken: string): Promise<RefreshedTokens> {
  const res = await connection.sendCommand("ProtoOARefreshTokenReq", { refreshToken });
  const accessToken: string = res.accessToken;
  const newRefreshToken: string = res.refreshToken;
  if (!accessToken || !newRefreshToken) {
    throw new Error("refresh response missing accessToken/refreshToken");
  }
  return { accessToken, refreshToken: newRefreshToken, expiresInSec: Number(res.expiresIn) || 0 };
}

// Set or replace a KEY=value line in .env text, preserving every other line,
// comment and the file's newline style. Appends the key if it is not present.
function upsertEnvVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const needsNl = text.length > 0 && !text.endsWith("\n");
  return `${text}${needsNl ? nl : ""}${line}${nl}`;
}

// Persist the refreshed pair so a restart (or the next refresh) uses them.
// Updates process.env immediately, then rewrites .env in place. A write failure
// is non-fatal — the in-memory tokens still drive the current session.
//
// The rotated pair belongs to the WHOLE process (one shared token across every
// environment), so it is always written as the flat ACCESS_TOKEN/REFRESH_TOKEN
// lines. A legacy CTRADER_CREDENTIALS that still embeds per-entry tokens is left
// alone on disk — loadEnvironments prefers the flat variables, so the fresh pair
// wins at parse, and the stale per-entry values are ignored.
export function persistTokens(accessToken: string, refreshToken: string, env?: EnvName): void {
  // Escape hatch for diagnostics run against a live account: a refresh rotates the
  // token at the BROKER, so a test that triggers one will invalidate the grant for
  // any other process sharing these credentials. Setting CTRADER_NO_TOKEN_PERSIST
  // keeps the rotated pair in memory only, so at least the .env on disk still holds
  // a pair that matches what other processes are using.
  const persistToDisk = process.env.CTRADER_NO_TOKEN_PERSIST !== "1";
  if (!persistToDisk) {
    console.warn("[CTRADER] CTRADER_NO_TOKEN_PERSIST=1: refreshed tokens NOT written to .env (in-memory only)");
  }

  process.env.ACCESS_TOKEN = accessToken;
  process.env.REFRESH_TOKEN = refreshToken;
  if (!persistToDisk) return;

  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    let updated = upsertEnvVar(existing, "ACCESS_TOKEN", accessToken);
    updated = upsertEnvVar(updated, "REFRESH_TOKEN", refreshToken);
    fs.writeFileSync(envPath, updated);
    console.log(`[CTRADER] Refreshed tokens persisted to .env (shared across environments${env ? ` — refreshed for ${env}` : ""})`);
  } catch (err: any) {
    console.warn(`[CTRADER] Could not persist refreshed tokens to .env: ${err.message || err}`);
  }
}