// The account registry: the single source of truth for which cTrader accounts
// this bot holds sessions for, and what each one is FOR.
//
// Historically the bot traded exactly one account, read straight off
// process.env.ACCOUNT_ID at ~24 call sites. One OAuth grant can cover many
// accounts (a single access token authenticates all of them, each via its own
// account-level auth request over the same connection), so the account a given
// piece of code acts on has to become explicit rather than implicit-singular.
//
// Roles, not positions in a list, decide behaviour. Adding a role later means
// adding a string and the code that reads it — never restructuring the list.

// A role is an open string rather than a union so new roles are additive.
// "primary" is the only one with behaviour attached today: it is the account
// the bot trades. Everything else is authenticated and held, nothing more.
export type AccountRole = string;

export const PRIMARY: AccountRole = "primary";

export interface TradingAccount {
  // The number shown in cTrader's UI (ProtoOATrader.traderLogin). Human-facing,
  // what a user can actually read off their platform, and what they configure.
  login: number;
  // The internal ctidTraderAccountId every trade request needs. NOT the login,
  // and not derivable from it — resolved from the broker at startup.
  ctid: number;
  role: AccountRole;
}

// Configured before resolution: the login is known, the ctid is not yet.
interface ConfiguredAccount {
  login: number | null; // null when a legacy config supplied a ctid directly
  ctid: number | null;
  role: AccountRole;
}

let accounts: TradingAccount[] = [];
let resolved = false;

// Parse CTRADER_ACCOUNTS: a JSON array of {login, role}, e.g.
//   CTRADER_ACCOUNTS=[{"login":5860760,"role":"primary"},{"login":123,"role":"source"}]
// Throws on malformed config: a typo here must fail loudly at boot, not
// silently drop an account and surface later as a confusing trade-time error.
function parseMultiAccountConfig(raw: string): ConfiguredAccount[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`CTRADER_ACCOUNTS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CTRADER_ACCOUNTS must be a non-empty JSON array");
  }

  const out: ConfiguredAccount[] = parsed.map((entry: any, i: number) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`CTRADER_ACCOUNTS[${i}] must be an object`);
    }
    const role = String(entry.role || "").trim();
    if (!role) throw new Error(`CTRADER_ACCOUNTS[${i}] is missing "role"`);

    // Accept either a login (preferred, resolved via the broker) or an explicit
    // ctid, so someone who already knows their internal id is not forced to
    // depend on the resolution call.
    const login = entry.login != null ? Number(entry.login) : null;
    const ctid = entry.ctid != null ? Number(entry.ctid) : null;
    if (login === null && ctid === null) {
      throw new Error(`CTRADER_ACCOUNTS[${i}] needs "login" (or "ctid")`);
    }
    if (login !== null && !Number.isFinite(login)) {
      throw new Error(`CTRADER_ACCOUNTS[${i}].login is not a number: ${entry.login}`);
    }
    if (ctid !== null && !Number.isFinite(ctid)) {
      throw new Error(`CTRADER_ACCOUNTS[${i}].ctid is not a number: ${entry.ctid}`);
    }
    return { login, ctid, role };
  });

  const primaries = out.filter((a) => a.role === PRIMARY);
  if (primaries.length === 0) {
    throw new Error(`CTRADER_ACCOUNTS must contain exactly one account with role "${PRIMARY}" (found none)`);
  }
  if (primaries.length > 1) {
    throw new Error(`CTRADER_ACCOUNTS must contain exactly one account with role "${PRIMARY}" (found ${primaries.length})`);
  }
  return out;
}

// Read config in precedence order: multi-account when present, else the legacy
// single ACCOUNT_ID. A deployed user with only ACCOUNT_ID set gets exactly one
// primary account and a code path identical to before this file existed.
function loadConfig(): ConfiguredAccount[] {
  const multi = (process.env.CTRADER_ACCOUNTS || "").trim();
  if (multi) return parseMultiAccountConfig(multi);

  const legacy = (process.env.ACCOUNT_ID || "").trim();
  if (!legacy) throw new Error("No account configured: set ACCOUNT_ID (or CTRADER_ACCOUNTS)");

  // ACCOUNT_ID has always been the ctidTraderAccountId, not the login. Keep
  // treating it as such: it needs no resolution and must not be re-interpreted.
  const ctid = Number(legacy);
  if (!Number.isFinite(ctid)) throw new Error(`ACCOUNT_ID is not a number: ${legacy}`);
  return [{ login: null, ctid, role: PRIMARY }];
}

// Ask the broker which accounts this access token actually grants, so a login
// number can be turned into the ctidTraderAccountId that trade requests need.
// Returns login -> ctid. Never guessed, never derived from the UI number.
async function fetchAccountList(connection: any, accessToken: string): Promise<Map<number, number>> {
  const res = await connection.sendCommand("ProtoOAGetAccountListByAccessTokenReq", { accessToken });
  const map = new Map<number, number>();
  for (const acc of res.ctidTraderAccount || []) {
    // int64 fields arrive as strings from the cTrader layer; coerce both.
    const ctid = Number(acc.ctidTraderAccountId);
    const login = Number(acc.traderLogin);
    if (Number.isFinite(ctid) && Number.isFinite(login)) map.set(login, ctid);
  }
  return map;
}

// Resolve configured accounts to their ctids and cache the result. Called once
// per process during boot, on an app-authenticated connection and BEFORE any
// account-level auth. Deliberately not re-run on reconnect: ctids are stable
// for the life of the grant, so re-resolving would add a failure point to the
// recovery path for no gain.
export async function resolveAccounts(connection: any, accessToken: string): Promise<TradingAccount[]> {
  if (resolved) return accounts;

  const configured = loadConfig();
  const needsLookup = configured.some((a) => a.ctid === null);

  let byLogin = new Map<number, number>();
  if (needsLookup) {
    byLogin = await fetchAccountList(connection, accessToken);
    if (byLogin.size === 0) {
      throw new Error("Broker returned no accounts for this access token (check CLIENT_ID/ACCESS_TOKEN and demo-vs-live host)");
    }
  }

  accounts = configured.map((a) => {
    if (a.ctid !== null) return { login: a.login ?? a.ctid, ctid: a.ctid, role: a.role };
    const ctid = byLogin.get(a.login!);
    if (ctid === undefined) {
      const known = [...byLogin.keys()].join(", ") || "none";
      throw new Error(`Account login ${a.login} is not granted to this access token (token covers: ${known})`);
    }
    return { login: a.login!, ctid, role: a.role };
  });

  resolved = true;

  // Log the full mapping at startup so a misconfigured account is obvious here
  // rather than surfacing later as an opaque trade-time rejection.
  console.log(`[ACCOUNTS] ${accounts.length} account(s) configured:`);
  for (const a of accounts) {
    const loginNote = a.login === a.ctid ? "(from ACCOUNT_ID)" : `login ${a.login}`;
    console.log(`[ACCOUNTS]   ${loginNote} -> ctid ${a.ctid} [${a.role}]`);
  }
  return accounts;
}

export function getAccounts(): TradingAccount[] {
  return accounts;
}

export function accountsByRole(role: AccountRole): TradingAccount[] {
  return accounts.filter((a) => a.role === role);
}

export function accountByCtid(ctid: number): TradingAccount | undefined {
  return accounts.find((a) => a.ctid === ctid);
}

// The account the bot trades. Every call site that used to read
// process.env.ACCOUNT_ID calls this instead, so "which account" is explicit.
//
// Falls back to reading ACCOUNT_ID directly when the registry has not been
// resolved yet, which preserves the old behaviour exactly for any code path
// that runs before boot completes (and keeps the legacy single-account user's
// behaviour byte-for-byte identical).
export function primaryAccountId(): number {
  if (resolved) {
    const primary = accounts.find((a) => a.role === PRIMARY);
    if (primary) return primary.ctid;
  }
  return parseInt(process.env.ACCOUNT_ID || "0");
}

// Test/boot helper: drop cached state so a fresh resolve can run.
export function resetAccounts(): void {
  accounts = [];
  resolved = false;
}
