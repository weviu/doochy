import { CTraderConnection } from "@reiryoku/ctrader-layer";
import { symbolIdFor, runtimeFor, primaryRuntimes, RuntimeState } from "../state";
import { setConnection, reconcilePositions } from "./orders";
import { reseedAfterReconnect } from "../risk/engine";
import { setLivePriceConnection, subscribeOpenPositions, subscribeSpots, subscribeConversionPairs, resetSpotSubscriptions } from "./livePrices";
import { setAmendConnection } from "./amend";
import { setMidnightConnection } from "../risk/midnightClose";
import { setExportConnection } from "../bot/commands/export";
import { setStatusConnection } from "../bot/commands/status";
import { setMiniAppConnection } from "../miniapp/service";
import { ensureBrokerDirectory } from "./brokerDirectory";
import { refreshAccessToken, persistTokens } from "./token";
import { resolveAccounts, getAccounts, accountByCtid, configuredEnvironments, TradingAccount, PRIMARY } from "./accounts";
import { watchSourceAccount, reportSourceGap, SOURCE_ROLE } from "../copytrade/sourceWatcher";
import {
  loadEnvironments,
  EnvConfig,
  EnvName,
  envForAccount,
  connectionFor,
  storeConnection,
  dropConnection,
  allConnections,
} from "./environments";

// cTrader connection lifecycle: connect, authenticate, wire every module,
// keep-alive, token refresh, and the reconnect-forever loop with its watchdog.
// Extracted verbatim from src/index.ts so the legacy single-user entrypoint and
// the Agent entrypoint share ONE copy of the most safety-critical code in the
// bot; a fix here reaches both.
//
// Multi-environment: every piece of the lifecycle runs ONCE PER environment
// ("demo" and "live" are separate cTrader hosts), and each environment only
// serves the accounts configured on it. An environment's reconnect and health
// check never touch the other environment's socket. Token refresh, however, is
// GLOBAL: one app token is shared across all environments (generating a second
// pair would invalidate the first), so a single refresh rotates the pair for the
// whole process at once.

// How long any single broker request may wait for its response before we treat it
// as failed. The @reiryoku/ctrader-layer has NO request timeout and its socket
// close/error handlers are no-ops, so a silently dropped connection (which does
// happen: the TCP link dies with no FIN/RST) would otherwise leave every await
// pending forever: the bot keeps running but never trades again until restarted.
const REQUEST_TIMEOUT_MS = 15_000;
// Health check cadence. Every tick we send a trivial request; if it times out the
// connection is dead and we reconnect.
const HEALTH_CHECK_MS = 20_000;

// Broker error codes that a fresh access token can actually fix, and therefore
// the ONLY ones that may trigger a refresh. Deliberately an exact-match allowlist:
// a refresh rotates the token and invalidates it for every other connection under
// the grant, so refreshing on an error that a new token cannot fix is actively
// destructive. Anything not listed here propagates to reconnect() instead.
//
// The token is SHARED across every environment (one pair authenticates all
// hosts), so a refresh rotates the grant for every environment — which is why
// the refresh gate below is global rather than per environment.
const TOKEN_ERROR_CODES = new Set([
  "CH_ACCESS_TOKEN_INVALID",     // token rejected outright
  "ACCESS_TOKEN_EXPIRED",        // lifetime elapsed
  "OA_AUTH_TOKEN_EXPIRED",       // same, older naming
  "CH_EXPIRED_ACCESS_TOKEN",     // same, alternate naming
  "INVALID_REQUEST",             // returned when the token is absent/malformed
]);

// The config for one environment (host, port, tokens), read (and live-mutated
// on token refresh) from the environment registry.
function envConfig(env: EnvName): EnvConfig {
  const found = loadEnvironments().find((e) => e.env === env);
  if (!found) throw new Error(`No configured environment "${env}"`);
  return found;
}

// The accounts that hold a live session on whichever environment, tracked per
// account so one account's session dying is visible without implying anything
// about the others. Cleared for an environment's accounts when its socket is
// rebuilt (a new connection starts with zero account sessions).
const liveSessions = new Set<number>();
// Guards against two concurrent re-auths of the same account (a disconnect event
// and a watchdog failure can both fire for one account at nearly the same time).
const reauthInFlight = new Set<number>();
// Which environments are currently mid-reconnect (guards overlapping reconnects
// per environment, as the old single `reconnecting` flag did for one socket).
const reconnectingEnvs = new Set<EnvName>();

const heartbeatTimers = new Map<EnvName, NodeJS.Timeout>();
// Proactive token-refresh timer (ONE, global — the access token is shared by
// every environment). cTrader tells us the token lifetime only in a refresh
// response, so this is (re)armed after each successful refresh to renew again at
// ~50% of the remaining life.
let tokenRefreshTimer: NodeJS.Timeout | null = null;

// Because ONE token serves every environment, several recovery paths can race for
// the same rotation: two environments' account-auth failures, a proactive timer,
// and a reconnect all firing at once. Refreshing twice in a row just doubles the
// invalidations — the second rotation kills the sessions the first just restored.
// A single in-flight refresh plus a short cooldown lets every late arrival reuse
// the freshly-rotated token from the registry instead of rotating again.
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 30_000;

const accountsForEnv = (env: EnvName): TradingAccount[] =>
  getAccounts().filter((a) => a.env === env);

export function getCtrader(): any {
  for (const [, conn] of allConnections()) return conn;
  return null;
}

// Wrap sendCommand so a never-answered request rejects instead of hanging forever.
// Events are resolved synchronously by the layer, so only guard "...Req" calls.
function installRequestTimeout(connection: any): void {
  const raw = connection.sendCommand.bind(connection);
  connection.sendCommand = (name: string, data?: any, id?: any) => {
    const p = raw(name, data, id);
    if (!/req$/i.test(name)) return p;
    return Promise.race([
      p,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`cTrader request timed out: ${name}`)), REQUEST_TIMEOUT_MS)
      ),
    ]);
  };
}

// The first live connection available, used as the channel for a token refresh
// (an app-level request — any live socket works, whichever environment owns it).
function currentConnection(): any | undefined {
  for (const [, conn] of allConnections()) if (conn) return conn;
  return undefined;
}

// Refresh the SHARED access token ON `connection`, fold the rotated pair into
// EVERY environment's config (they all carry the same pair), persist it as the
// flat .env variables, and re-arm the single proactive timer from the reported
// lifetime. The token belongs to the whole process, so a refresh is never
// scoped to one environment.
async function doRefresh(connection: any, initiator: string): Promise<void> {
  const envs = loadEnvironments();
  if (envs.length === 0) throw new Error("No environments configured");
  const r = await refreshAccessToken(connection, envs[0].refreshToken);
  for (const e of envs) {
    e.accessToken = r.accessToken;
    e.refreshToken = r.refreshToken;
  }
  lastRefreshAt = Date.now();
  persistTokens(r.accessToken, r.refreshToken);
  console.log(`[CTRADER] Access token refreshed (initiated by ${initiator}; expires in ~${Math.round(r.expiresInSec / 3600)}h)`);
  scheduleProactiveRefresh(connection, r.expiresInSec);
}

// Rotate the shared token exactly once across any number of concurrent callers.
// Callers within the cooldown window (or waiting on an in-flight refresh) get
// back immediately: the fresh pair is already folded into every environment's
// config, so they simply retry auth against it.
async function ensureTokenRefreshed(connection: any, initiator: string): Promise<void> {
  if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return;
  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }
  try {
    refreshInFlight = doRefresh(connection, initiator);
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// (Re)arm the proactive refresh at half the remaining lifetime (floor 5 min, cap
// 24h). Skipped when the broker reports no/unknown expiry. Kept independent of the
// health check so a healthy-but-aging token is renewed before it can lapse.
function scheduleProactiveRefresh(connection: any, expiresInSec: number): void {
  if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
  if (!expiresInSec || expiresInSec <= 0) return;
  const delayMs = Math.min(24 * 3600_000, Math.max(300_000, (expiresInSec * 1000) / 2));
  tokenRefreshTimer = setTimeout(async () => {
    tokenRefreshTimer = null;
    try {
      // Refresh on the current live connection, not the (possibly stale) one the
      // timer was armed with; a reconnect may have replaced it.
      const conn = currentConnection() ?? connection;
      if (!conn) return;
      await ensureTokenRefreshed(conn, "proactive");
    } catch (err: any) {
      console.warn(`[CTRADER] Proactive token refresh failed: ${err.errorCode || err.message || err}. Health check will recover via reconnect if the session dies.`);
    }
  }, delayMs);
}

// Authenticate ONE account, refreshing its environment's access token once if the
// broker rejects it as expired/invalid. This is the recovery hinge: on reconnect
// after a token expiry, the first account-auth fails, we refresh with the
// (still-valid) refresh token, and retry, so the session comes back without a
// manual token re-issue.
//
// The account is passed in explicitly rather than read from module config: with
// several accounts on one connection, "the account" is no longer well defined.
// The environment's config is read from the account registry (account.env), so a
// refresh mutates the right environment's token pair.
async function authenticateAccount(connection: any, account: TradingAccount): Promise<void> {
  const cfg = envConfig(account.env);
  const authOnce = () => connection.sendCommand("ProtoOAAccountAuthReq", {
    ctidTraderAccountId: account.ctid,
    accessToken: cfg.accessToken,
  });
  try {
    await authOnce();
  } catch (err: any) {
    const code = String(err?.errorCode || "").toUpperCase();

    // The session we were asking for already exists. This is a SUCCESS, not a
    // failure: whenever two recovery paths race for one account (a disconnect
    // event and a watchdog check, say), which multi-account makes a normal
    // occurrence rather than a rarity. Treating it as an error triggered a
    // needless token refresh, and since a refresh ROTATES the token, that
    // invalidated the grant for every other connection using it.
    if (code === "ALREADY_LOGGED_IN") {
      liveSessions.add(account.ctid);
      console.log(`[CTRADER] Account ${account.ctid} [${account.role}] already authenticated on ${account.env} connection`);
      return;
    }

    // Refresh ONLY on errors that a new access token can actually fix, matched by
    // explicit error code. This was previously a substring test against the code
    // and description together (/token|auth|expire|invalid/), which matched far
    // more than intended: "ALREADY_LOGGED_IN Trading account is already
    // authorized" contains "auth", so a benign already-authorized reply forced a
    // token rotation. A bare socket timeout must also fall through — a dead link
    // is not fixed by a refresh, and reconnect() rebuilding the socket is the
    // correct recovery.
    if (!TOKEN_ERROR_CODES.has(code)) throw err;

    const reason = `${err?.errorCode || ""} ${err?.description || ""}`.trim();
    console.warn(`[CTRADER] Account auth rejected for ${account.ctid} [${account.role}] (${reason}); refreshing the shared access token and retrying`);
    await ensureTokenRefreshed(connection, `auth ${account.ctid}`);
    await authOnce();
  }
  liveSessions.add(account.ctid);
  console.log(`[CTRADER] Account authenticated: ${account.ctid} [${account.role}] (${account.env})`);
}

// Authenticate every configured account of ONE environment over its connection.
// Each needs its own account-level auth request; an app-level token being valid
// does not establish an account session by itself.
//
// The PRIMARY account is the one the bot trades, so a failure there is fatal to
// that environment's attempt and propagates (boot aborts, or reconnect retries
// with backoff). A non-primary account failing is logged and skipped: it carries
// no trading behaviour, and taking the whole bot down over it would make adding
// an account strictly riskier than not having one.
async function authenticateAllAccounts(connection: any, env: EnvName): Promise<void> {
  // On a source-only node the source account is the whole point of the process, so
  // its auth is mandatory (a bad token should fail at boot, not run a dead
  // watcher). On a normal node only the primary is mandatory; other roles are
  // held best-effort so one bad source can't stop the bot from trading.
  const onlySource = process.env.COPYTRADE_SOURCE_ONLY === "1";
  for (const account of accountsForEnv(env)) {
    if (account.role === PRIMARY || onlySource) {
      await authenticateAccount(connection, account);
      continue;
    }
    try {
      await authenticateAccount(connection, account);
    } catch (err: any) {
      console.error(`[CTRADER] Could not authenticate ${account.ctid} [${account.role}]: ${err.errorCode || err.message || err}. Continuing without it.`);
    }
  }
}

// Re-establish ONE account's session on its environment's existing socket, without
// tearing the connection down. This is what makes multi-account safe: the broker
// can drop a single account's session while the socket and every other account's
// session stay perfectly healthy, so the response must be scoped to that account.
// Rebuilding a whole connection here would turn one account's hiccup into an
// outage for all of them. A failure escalates to the account's OWN environment's
// reconnect, never the others.
async function reauthAccount(account: TradingAccount, reason: string): Promise<void> {
  const conn = connectionFor(account.env);
  if (reconnectingEnvs.has(account.env) || !conn) return; // a full reconnect will re-auth everyone anyway
  if (reauthInFlight.has(account.ctid)) return;
  reauthInFlight.add(account.ctid);
  liveSessions.delete(account.ctid);
  // The source account's session dropping is a copy-trade gap even though the
  // socket survives: fills landing before it is restored raise no event we see.
  if (account.role === SOURCE_ROLE) reportSourceGap(reason, null);
  try {
    console.warn(`[CTRADER] Re-authenticating ${account.ctid} [${account.role}] (${reason})`);
    await authenticateAccount(conn, account);
    // The primary accounts drive trading state, so each one's streams and
    // positions must be resynced after a gap; a non-primary session has none to
    // restore.
    if (account.role === PRIMARY) {
      const rt = runtimeFor(account.ctid);
      await resubscribeStreams(rt);
      await reconcilePositions(rt);
      console.log(`[CTRADER] ${account.ctid} [${account.role}] session restored; streams and positions re-synced`);
    } else {
      console.log(`[CTRADER] ${account.ctid} [${account.role}] session restored`);
    }
  } catch (err: any) {
    // A targeted re-auth failing means the problem is not scoped to this account
    // (dead socket, invalid token). Escalate to a full reconnect, which is the
    // path that rebuilds the socket and refreshes the token.
    console.warn(`[CTRADER] Targeted re-auth of ${account.ctid} failed: ${err.errorCode || err.message || err}; escalating to ${account.env} reconnect`);
    await reconnect(account.env, `re-auth failed for account ${account.ctid}`);
  } finally {
    reauthInFlight.delete(account.ctid);
  }
}

// The broker announces a dying session with these push events (rather than
// dropping the socket). Catch them and recover immediately; otherwise the session
// stays dead until the next health check notices. Events arrive on ONE environment's
// socket and are recovered on that environment.
function installSessionListeners(connection: any, env: EnvName): void {
  // Token invalidation is grant-wide: every account under this token is affected,
  // so this correctly stays a full reconnect (which also refreshes the token) for
  // THIS environment only.
  connection.on("ProtoOAAccountsTokenInvalidatedEvent", (event: any) => {
    const d = event.descriptor ?? event;
    console.warn(`[CTRADER] Broker invalidated the ${env} token: ${d?.reason || "no reason given"}; refreshing + reconnecting`);
    reconnect(env, "token invalidated by broker");
  });
  // A disconnect event names the account it applies to. Route on it and re-auth
  // just that account, leaving the socket and the other sessions untouched. When
  // the id is missing or unknown, fall back to the full reconnect for the
  // environment that owns this socket: an unattributable disconnect is not safe
  // to treat as narrowly scoped.
  connection.on("ProtoOAAccountDisconnectEvent", (event: any) => {
    const d = event.descriptor ?? event;
    const ctid = Number(d?.ctidTraderAccountId);
    const account = Number.isFinite(ctid) ? accountByCtid(ctid) : undefined;
    if (!account) {
      console.warn(`[CTRADER] Broker disconnected an unidentified account session on ${env} (${d?.ctidTraderAccountId ?? "no id"}); reconnecting`);
      reconnect(env, "account disconnected by broker");
      return;
    }
    reauthAccount(account, "disconnected by broker");
  });
}

// Open a socket for ONE environment: authenticate the application and that
// environment's accounts, and return the ready connection. Used for the first
// connect and every reconnect of the environment.
async function buildConnection(env: EnvName): Promise<any> {
  const cfg = envConfig(env);
  const connection = new CTraderConnection({
    host: cfg.host,
    port: cfg.port,
  });

  // open() is NOT covered by installRequestTimeout (that wraps sendCommand, and is
  // applied below). The cTrader layer's open() can hang forever if the socket
  // half-opens during a network drop mid-reconnect, wedging reconnect() on this
  // attempt with reconnecting=true, which also disables the watchdog, so the bot
  // never recovers without a restart. Bound it so a stalled open rejects and the
  // reconnect loop retries with backoff instead.
  await Promise.race([
    connection.open(),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("socket open timed out")), REQUEST_TIMEOUT_MS)
    ),
  ]);
  installRequestTimeout(connection);
  console.log(`[CTRADER] Socket opened (${env})`);

  await connection.sendCommand("ProtoOAApplicationAuthReq", {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  console.log(`[CTRADER] Application authenticated (${env})`);

  // Resolve this environment's configured accounts (login -> ctidTraderAccountId)
  // before any account-level auth. Cached after the first success, so this is a
  // no-op on every reconnect and adds no failure point to the recovery path.
  await resolveAccounts(connection, cfg.accessToken, env);

  // A fresh socket carries no account sessions, whatever the previous one had.
  for (const a of accountsForEnv(env)) liveSessions.delete(a.ctid);
  await authenticateAllAccounts(connection, env);
  installSessionListeners(connection, env);

  return connection;
}

// Point every module at ONE environment's connection and (re)start that
// environment's keep-alive heartbeat. The setters store the reference per
// environment, read fresh on each use, so calling them again after a reconnect
// transparently redirects everything for that environment.
function wireConnection(env: EnvName, connection: any): void {
  storeConnection(env, connection);
  setConnection(env, connection);
  setLivePriceConnection(env, connection);
  setAmendConnection(env, connection);
  setMidnightConnection(env, connection);
  setExportConnection(env, connection);
  setStatusConnection(env, connection);
  setMiniAppConnection(env, connection);

  // Re-attach the copy-trade subscriber to the new socket (only relevant when
  // this environment hosts the source account). Its listener lived on the old
  // connection and died with it, so without this a reconnect would leave the
  // source account silently unwatched.
  watchSourceAccount(env, connection);

  // cTrader drops the push channel if no message is sent for ~10s. Keep it alive.
  const prev = heartbeatTimers.get(env);
  if (prev) clearInterval(prev);
  heartbeatTimers.set(env, setInterval(() => {
    try { connection.sendHeartbeat(); } catch { /* dead socket: watchdog reconnects */ }
  }, 10_000));
}

// (Re)subscribe every stream ONE traded account relies on: spots for allowed
// symbols and open positions, plus the USD conversion pairs for any non-USD-quoted
// ones. A new socket starts with zero subscriptions, so reset the cache first
// (the reset clears the account's bookkeeping; the account is re-subscribed
// below with account-scoped requests).
async function resubscribeStreams(rt: RuntimeState): Promise<void> {
  const env = envForAccount(rt.ctid);
  if (env === undefined) return;
  resetSpotSubscriptions(env);
  const allowedSymbolIds = [...new Set(
    rt.settings.allowedSymbols
      .map((s) => symbolIdFor(s, rt.ctid))
      .filter((id): id is number => id !== undefined)
  )];
  await subscribeSpots(rt, allowedSymbolIds);
  await subscribeConversionPairs(rt, rt.settings.allowedSymbols);
  await subscribeOpenPositions(rt);
  await subscribeConversionPairs(rt, [...rt.positions.values()].map((p) => p.symbol));
}

// Tear down ONE environment's dead connection and rebuild it end-to-end: re-auth,
// re-wire every module, re-subscribe streams, and re-adopt broker positions.
// Retries forever with backoff; a broker/network outage must not permanently wedge
// the bot. Guarded so overlapping health-check failures can't start two reconnects
// for the same environment at once. Never touches the other environments.
async function reconnect(env: EnvName, reason: string): Promise<void> {
  if (reconnectingEnvs.has(env)) return;
  reconnectingEnvs.add(env);
  console.warn(`[CTRADER] ${env} connection lost (${reason}); reconnecting`);

  const oldHeartbeat = heartbeatTimers.get(env);
  if (oldHeartbeat) { clearInterval(oldHeartbeat); heartbeatTimers.delete(env); }
  // The socket is going away, so no of this environment's account sessions
  // survive it. Clear before rebuilding so nothing reads a stale "live" session
  // during the gap.
  for (const a of accountsForEnv(env)) liveSessions.delete(a.ctid);
  // From here until the subscriber is re-attached the source account is unwatched,
  // and fills in that window are lost (no backfill is possible on this API).
  if (accountsForEnv(env).some((a) => a.role === SOURCE_ROLE)) reportSourceGap(reason, null);
  try { connectionFor(env)?.close?.(); } catch { /* already gone */ }
  dropConnection(env);

  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await buildConnection(env);
      wireConnection(env, connection);
      // Re-subscribe streams and re-adopt open positions per traded account on this
      // environment, then refresh their broker-side SL/TP after the gap.
      for (const rt of primaryRuntimes()) {
        if (envForAccount(rt.ctid) !== env) continue;
        await resubscribeStreams(rt);
        await reconcilePositions(rt);
      }
      // Re-seed today's realized P&L for this environment's accounts. Closes that
      // happened while we were disconnected raise no execution event, so the
      // in-memory counter would silently understate the day and the loss limit
      // would not bite when it should. The engine takes the broker's figure per
      // account and re-evaluates each.
      await reseedAfterReconnect(env);
      console.log(`[CTRADER] Reconnected ${env} (attempt ${attempt}); streams and positions re-synced`);
      break;
    } catch (err: any) {
      const wait = Math.min(30_000, 2_000 * attempt);
      console.warn(`[CTRADER] ${env} reconnect attempt ${attempt} failed: ${err.message || err}. Retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  reconnectingEnvs.delete(env);
}

// First connect: build and wire every configured environment that has accounts.
// A primary failure on any environment aborts boot (that environment cannot
// trade, and the misconfiguration should be loud, not survived). Environments
// with no configured accounts never connect. The account check is against the
// CONFIGURED list: resolution runs inside buildConnection, so at this point the
// resolved registry is still empty and would make every env appear unconfigured.
export async function startCTrader(): Promise<void> {
  // Kick off the broker-name/login directory lookup in the background (purely
  // cosmetic display data; boot never waits on it and a failure is logged and
  // swallowed). It needs the shared access token, so it must run after the
  // environments are loadable.
  try {
    const envs = loadEnvironments();
    if (envs.length > 0) ensureBrokerDirectory(envs[0].accessToken);
  } catch { /* boot fails loudly on missing credentials below */ }

  const configuredEnvs = new Set(configuredEnvironments());
  for (const cfg of loadEnvironments()) {
    if (!configuredEnvs.has(cfg.env)) {
      console.log(`[CTRADER] Environment "${cfg.env}" has no accounts configured; skipping its connection`);
      continue;
    }
    console.log(`[CTRADER] Connecting environment "${cfg.env}" (${cfg.host}:${cfg.port})`);
    const connection = await buildConnection(cfg.env);
    wireConnection(cfg.env, connection);
  }
  console.log("[CTRADER] All environments connected");
}

// Periodically prove each environment's connection can still round-trip an
// ACCOUNT-scoped request. ProtoOATraderReq is market-independent (so it won't
// false-trigger on a quiet symbol) but, unlike the old app-level ProtoOAVersionReq,
// it exercises the account session itself: if the access token has expired the
// socket stays up and a version ping still succeeds, yet every real request
// (reconcile, margin, orders) fails. A failure here, timeout OR an auth/invalid
// error, triggers reconnect() for that environment, which re-auths and refreshes
// the token, bringing trading back without a manual restart.
// Each account is checked independently, because with several sessions on one
// socket a single account's failure no longer implies the connection is dead.
// The PRIMARY account is its environment's health proxy: if its check fails the
// bot cannot trade on that environment, so that escalates to a full reconnect
// exactly as before. A non-primary failure is scoped to that account and gets a
// targeted re-auth, which cannot disturb the primary session.
export function startConnectionWatchdog(): void {
  setInterval(async () => {
    for (const cfg of loadEnvironments()) {
      if (reconnectingEnvs.has(cfg.env)) continue;
      const conn = connectionFor(cfg.env);
      if (!conn) continue;
      for (const account of accountsForEnv(cfg.env)) {
        if (reconnectingEnvs.has(cfg.env)) break; // a reconnect started mid-sweep; it re-auths everyone
        if (reauthInFlight.has(account.ctid)) continue;
        try {
          await conn.sendCommand("ProtoOATraderReq", { ctidTraderAccountId: account.ctid });
          liveSessions.add(account.ctid);
        } catch (err: any) {
          const detail = err.errorCode || err.message || err;
          if (account.role === PRIMARY) {
            await reconnect(cfg.env, `health check failed: ${detail}`);
            break;
          }
          await reauthAccount(account, `health check failed: ${detail}`);
        }
      }
    }
  }, HEALTH_CHECK_MS);
  console.log(`[CTRADER] Connection watchdog active (per-account health check every ${HEALTH_CHECK_MS / 1000}s per environment)`);
}

// Which accounts hold a live session right now. Exposed for status/diagnostics.
export function getLiveSessions(): number[] {
  return [...liveSessions];
}