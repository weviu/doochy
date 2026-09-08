import * as fs from "fs";
import * as path from "path";
import { loadEnvironments, hostForEnv, EnvName } from "./environments";

// cTrader access tokens expire (ProtoOARefreshTokenRes.expiresIn seconds). When
// the token behind the account session dies, the socket stays up and app-level
// pings keep passing, but every ACCOUNT-scoped request (reconcile, expected
// margin, new orders) starts failing — the bot looks "connected" yet silently
// stops trading. This module refreshes the access token using the refresh token
// and persists the rotated pair back to .env so a later refresh/restart uses the
// fresh tokens (the refresh token is single-use — it changes on every refresh).

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

// Replace a KEY's value even when the value spans MULTIPLE lines (as a JSON
// array in CTRADER_CREDENTIALS does). The key line is rewritten, and every
// following line up to the next assignment is consumed. Keeps the file's newline
// style. Returns whether the key was found (caller appends if not).
function replaceEnvValue(text: string, key: string, value: string): { text: string; found: boolean } {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}=`).test(lines[i])) { start = i; break; }
  }
  if (start === -1) return { text, found: false };
  lines[start] = `${key}=${value}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[i].trim())) { end = i; break; }
  }
  lines.splice(start + 1, end - (start + 1));
  return { text: lines.join(nl), found: true };
}

// Rebuild the whole CTRADER_CREDENTIALS value from the (live-mutated) environment
// registry. Every entry is written back with its CURRENT tokens plus any custom
// host/port, so the file always matches what the running process holds; known
// environments with derived hosts stay minimal.
function serializeCredentials(): string {
  const entries = loadEnvironments().map((e) => {
    let wantsHost = true;
    try {
      if (e.host === hostForEnv(e.env)) wantsHost = false;
    } catch { /* unknown env name: host was custom, keep it */ }
    const parts: string[] = [`"env":${JSON.stringify(e.env)}`];
    if (wantsHost) parts.push(`"host":${JSON.stringify(e.host)}`);
    if (e.port !== 5035) parts.push(`"port":${e.port}`);
    parts.push(`"accessToken":${JSON.stringify(e.accessToken)}`);
    parts.push(`"refreshToken":${JSON.stringify(e.refreshToken)}`);
    return `{${parts.join(",")}}`;
  });
  return `[${entries.join(",")}]`;
}

// Persist the refreshed pair so a restart (or the next refresh) uses them.
// Updates process.env immediately, then rewrites .env in place. A write failure
// is non-fatal — the in-memory tokens still drive the current session.
//
// In multi-environment mode the rotated pair belongs to ONE environment, so the
// refreshed values are folded back into the whole CTRADER_CREDENTIALS array and
// the key is rewritten (single- OR multi-line). In legacy single-environment mode
// the flat ACCESS_TOKEN/REFRESH_TOKEN lines are updated, unchanged.
export function persistTokens(accessToken: string, refreshToken: string, env?: EnvName): void {
  const structured = Boolean(process.env.CTRADER_CREDENTIALS && process.env.CTRADER_CREDENTIALS.trim().length > 0);
  // Escape hatch for diagnostics run against a live account: a refresh rotates the
  // token at the BROKER, so a test that triggers one will invalidate the grant for
  // any other process sharing these credentials. Setting CTRADER_NO_TOKEN_PERSIST
  // keeps the rotated pair in memory only, so at least the .env on disk still holds
  // a pair that matches what other processes are using.
  const persistToDisk = process.env.CTRADER_NO_TOKEN_PERSIST !== "1";
  if (!persistToDisk) {
    console.warn("[CTRADER] CTRADER_NO_TOKEN_PERSIST=1: refreshed tokens NOT written to .env (in-memory only)");
  }

  const envPath = path.resolve(process.cwd(), ".env");
  try {
    if (structured) {
      // The rotated values are already in the environment registry (doRefresh mutates
      // it upstream); rewriting the whole array keeps every token in sync at once.
      const serialized = serializeCredentials();
      process.env.CTRADER_CREDENTIALS = serialized;
      if (!persistToDisk) return;
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const out = replaceEnvValue(existing, "CTRADER_CREDENTIALS", serialized);
      const updated = out.found ? out.text : upsertEnvVar(existing, "CTRADER_CREDENTIALS", serialized);
      fs.writeFileSync(envPath, updated);
      if (env) console.log(`[CTRADER] Refreshed ${env} tokens persisted to .env`);
      return;
    }

    process.env.ACCESS_TOKEN = accessToken;
    process.env.REFRESH_TOKEN = refreshToken;
    if (persistToDisk) {
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      let updated = upsertEnvVar(existing, "ACCESS_TOKEN", accessToken);
      updated = upsertEnvVar(updated, "REFRESH_TOKEN", refreshToken);
      fs.writeFileSync(envPath, updated);
      console.log("[CTRADER] Refreshed tokens persisted to .env");
    }
  } catch (err: any) {
    console.warn(`[CTRADER] Could not persist refreshed tokens to .env: ${err.message || err}`);
  }
}
