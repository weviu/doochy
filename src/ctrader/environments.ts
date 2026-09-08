// Per-environment cTrader configuration and the live connection store.
//
// Historically one agent held ONE cTrader connection to ONE host, configured by
// a flat set of env vars (CTRADER_HOST, CLIENT_ID, ACCESS_TOKEN, ...). A demo
// account and a live account cannot share that connection: they live on
// different hosts, hold different OAuth tokens, and resolve different symbol
// ids. To trade both from one agent, each environment gets its own connection
// with its own token pair; the shared bits (clientId/clientSecret, port) stay
// global because they are identical across environments.
//
// Config is data-driven — CTRADER_CREDENTIALS is a JSON array with one entry per
// environment, and every configured account names its environment. Nothing is
// hardcoded to two environments or two accounts. The legacy flat config
// (CTRADER_HOST + CLIENT_ID/CLIENT_SECRET/ACCESS_TOKEN/REFRESH_TOKEN, with or
// without ACCOUNT_ID/CTRADER_ACCOUNTS) loads as a single environment named by
// its host, preserving the previous behaviour byte-for-byte.

export type EnvName = string;

export interface EnvConfig {
  env: EnvName;
  host: string;
  port: number;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

// The public demo/live hosts. Env names are open strings, but these two are the
// known-good ones and the only ones a host can be derived for.
export function hostForEnv(env: EnvName): string {
  switch (env) {
    case "demo":
      return "demo.ctraderapi.com";
    case "live":
      return "live.ctraderapi.com";
    default:
      throw new Error(
        `CTRADER_CREDENTIALS entry "${env}" is not a known environment (demo/live); add an explicit "host" to it`
      );
  }
}

// Infer the environment name from a host (legacy config path).
export function envFromHost(host: string): EnvName {
  return /live/i.test(host) ? "live" : "demo";
}

// Parse a CTRADER_CREDENTIALS entry into a full EnvConfig. Shared values come
// from the flat env vars (clientId/clientSecret are identical across
// environments, as is the ACCESS/REFRESH token pair — ONE app token works on
// every host, and generating a second pair would invalidate the first). An
// entry may still carry host/port overrides for a non-standard deployment.
// Tokens inside an entry are tolerated only for migration: an older
// CTRADER_CREDENTIALS that embedded per-environment tokens keeps working until
// the first refresh rewrites them as the shared flat pair.
function parseEntry(raw: string, i: number): EnvConfig {
  let entry: any;
  try {
    entry = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`CTRADER_CREDENTIALS is not valid JSON: ${err.message}`);
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`CTRADER_CREDENTIALS[${i}] must be an object`);
  }
  const env = String(entry.env || "").trim();
  if (!env) throw new Error(`CTRADER_CREDENTIALS[${i}] is missing "env"`);
  return {
    env,
    host: entry.host ? String(entry.host) : hostForEnv(env),
    port: entry.port != null ? Number(entry.port) : Number(process.env.CTRADER_PORT || "5035"),
    clientId: String(entry.clientId || process.env.CLIENT_ID || ""),
    clientSecret: String(entry.clientSecret || process.env.CLIENT_SECRET || ""),
    accessToken: String(entry.accessToken || ""),
    refreshToken: String(entry.refreshToken || ""),
  };
}

let envs: EnvConfig[] | null = null;

// All configured environments. CTRADER_CREDENTIALS when present; otherwise the
// legacy flat config as a single environment named by its host. Validated for
// unique env names and non-empty tokens. Called lazily (not at import time)
// because dotenv.config() runs after module imports across entrypoints.
export function loadEnvironments(): EnvConfig[] {
  if (envs) return envs;

  const multi = (process.env.CTRADER_CREDENTIALS || "").trim();
  if (multi) {
    const parts = splitJsonArray(multi);
    envs = parts.map(parseEntry);
  } else {
    envs = [
      {
        env: envFromHost(process.env.CTRADER_HOST || "demo.ctraderapi.com"),
        host: process.env.CTRADER_HOST || "demo.ctraderapi.com",
        port: parseInt(process.env.CTRADER_PORT || "5035"),
        clientId: process.env.CLIENT_ID || "",
        clientSecret: process.env.CLIENT_SECRET || "",
        accessToken: process.env.ACCESS_TOKEN || "",
        refreshToken: process.env.REFRESH_TOKEN || "",
      },
    ];
  }

  const seen = new Set<string>();
  for (const e of envs) {
    if (!e.clientId || !e.clientSecret) {
      throw new Error(`Environment "${e.env}": CLIENT_ID/CLIENT_SECRET are required and shared across environments`);
    }
    if (seen.has(e.env)) throw new Error(`CTRADER_CREDENTIALS lists environment "${e.env}" twice`);
    seen.add(e.env);
  }

  // ONE token pair serves every environment: a cTrader app token authenticates on
  // all hosts, and generating a second pair would invalidate the first. Prefer the
  // flat ACCESS_TOKEN/REFRESH_TOKEN; fall back to a legacy CTRADER_CREDENTIALS
  // that still embeds per-entry tokens (first pair wins) so an existing dual-env
  // .env keeps working until its next refresh rewrites it as the flat pair.
  const flatAccess = (process.env.ACCESS_TOKEN || "").trim();
  const flatRefresh = (process.env.REFRESH_TOKEN || "").trim();
  if (flatAccess && flatRefresh) {
    for (const e of envs) { e.accessToken = flatAccess; e.refreshToken = flatRefresh; }
  } else {
    const legacy = envs.find((e) => e.accessToken && e.refreshToken);
    if (!legacy) {
      throw new Error("A cTrader access token is required: set ACCESS_TOKEN/REFRESH_TOKEN (shared across environments), or carry them in a CTRADER_CREDENTIALS entry");
    }
    for (const e of envs) { e.accessToken = legacy.accessToken; e.refreshToken = legacy.refreshToken; }
  }
  return envs;
}

// .env values may drift toward an array-across-lines format; split on the JSON
// array brackets and parse each entry independently so a multi-line
// CTRADER_CREDENTIALS still parses cleanly.
function splitJsonArray(raw: string): string[] {
  const trimmed = raw.replace(/^\s*\[|\]\s*$/g, "");
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  let escape = false;
  for (const ch of trimmed) {
    if (inString) {
      current += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        current += ch;
        break;
      case "{":
        depth++;
        current += ch;
        break;
      case "}":
        depth--;
        current += ch;
        if (depth === 0) {
          parts.push(current.trim());
          current = "";
        }
        break;
      case ",":
        if (depth === 0) break; // top-level array separator
        current += ch;
        break;
      default:
        current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Reset the cached environment list (test/boot helper).
export function clearEnvironments(): void {
  envs = null;
  connections.clear();
}

// ---- live connection store --------------------------------------------------
//
// Stands in for the old single module-level `connection`: every module keeps
// pointing at a connection through the environment key, so one process can hold
// several live sockets at once and each command is routed to the socket that
// owns the account it targets.

const connections = new Map<EnvName, any>();

export function storeConnection(env: EnvName, conn: any): void {
  connections.set(env, conn);
}

export function dropConnection(env: EnvName): void {
  connections.delete(env);
}

export function connectionFor(env: EnvName): any {
  return connections.get(env);
}

export function allConnections(): Iterable<[EnvName, any]> {
  return connections.entries();
}

// Env name for an account's ctid, injected by accounts.ts (which owns the
// account registry) to keep this module free of a circular import.
type EnvResolver = (ctid: number) => EnvName | undefined;
let accountEnvResolver: EnvResolver | null = null;

export function setAccountEnvResolver(fn: EnvResolver): void {
  accountEnvResolver = fn;
}

export function envForAccount(ctid: number): EnvName | undefined {
  return accountEnvResolver ? accountEnvResolver(ctid) : undefined;
}

// Route a request to the connection that owns the account named by
// `data.ctidTraderAccountId`. Throws when the account or its env connection is
// unknown/missing — a misconfiguration must surface loudly rather than send an
// account-scoped request down the wrong socket.
export function sendWhere(name: string, data?: any, id?: any): Promise<any> {
  const ctid = Number(data?.ctidTraderAccountId);
  if (!Number.isFinite(ctid)) {
    throw new Error(`sendWhere(${name}): payload has no ctidTraderAccountId; route explicitly per environment`);
  }
  const env = envForAccount(ctid);
  if (!env) throw new Error(`sendWhere(${name}): no environment configured for account ${ctid}`);
  const conn = connectionFor(env);
  if (!conn) throw new Error(`sendWhere(${name}): no live connection for environment "${env}" (account ${ctid})`);
  return conn.sendCommand(name, data, id);
}