import { CTraderConnection } from "@reiryoku/ctrader-layer";
import { state, symbolIdFor } from "../state";
import { setConnection, reconcilePositions } from "./orders";
import { fetchTodayRealizedPnL } from "./account";
import { evaluateDailyLimits } from "../risk/dailyLoss";
import { setLivePriceConnection, subscribeOpenPositions, subscribeSpots, subscribeConversionPairs, resetSpotSubscriptions } from "./livePrices";
import { setAmendConnection } from "./amend";
import { setMidnightConnection } from "../risk/midnightClose";
import { setExportConnection } from "../bot/commands/export";
import { setStatusConnection } from "../bot/commands/status";
import { setMiniAppConnection } from "../miniapp/service";
import { refreshAccessToken, persistTokens } from "./token";
import { resolveAccounts, getAccounts, accountByCtid, TradingAccount, PRIMARY } from "./accounts";
import { watchSourceAccount, reportSourceGap, SOURCE_ROLE } from "../copytrade/sourceWatcher";

// cTrader connection lifecycle: connect, authenticate, wire every module,
// keep-alive, token refresh, and the reconnect-forever loop with its watchdog.
// Extracted verbatim from src/index.ts so the legacy single-user entrypoint and
// the Agent entrypoint share ONE copy of the most safety-critical code in the
// bot; a fix here reaches both.

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
const TOKEN_ERROR_CODES = new Set([
  "CH_ACCESS_TOKEN_INVALID",     // token rejected outright
  "ACCESS_TOKEN_EXPIRED",        // lifetime elapsed
  "OA_AUTH_TOKEN_EXPIRED",       // same, older naming
  "CH_EXPIRED_ACCESS_TOKEN",     // same, alternate naming
  "INVALID_REQUEST",             // returned when the token is absent/malformed
]);

// Read lazily (not at module load) because dotenv.config() runs in the
// entrypoint AFTER imports are evaluated; reading process.env here at import
// time would capture an empty environment.
let config: {
  host: string;
  port: number;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
} | null = null;

function cfg() {
  if (!config) {
    config = {
      host: process.env.CTRADER_HOST || "demo.ctraderapi.com",
      port: parseInt(process.env.CTRADER_PORT || "5035"),
      clientId: process.env.CLIENT_ID || "",
      clientSecret: process.env.CLIENT_SECRET || "",
      accessToken: process.env.ACCESS_TOKEN || "",
      refreshToken: process.env.REFRESH_TOKEN || "",
    };
  }
  return config;
}

// The current live connection. Every module points at this via its setter; on
// reconnect we build a new one and re-run the setters so they all follow.
let ctrader: any = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnecting = false;

// Which accounts currently hold a live session on `ctrader`, tracked per account
// so one account's session dying is visible without implying anything about the
// others. Cleared wholesale when the socket is rebuilt (a new connection starts
// with zero account sessions).
const liveSessions = new Set<number>();
// Guards against two concurrent re-auths of the same account (a disconnect event
// and a watchdog failure can both fire for one account at nearly the same time).
const reauthInFlight = new Set<number>();

export function getCtrader(): any {
  return ctrader;
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

// Proactive token-refresh timer. cTrader tells us the token lifetime only in a
// refresh response, so this is (re)armed after each successful refresh to renew
// again at ~50% of the remaining life, well before expiry, so the account
// session never silently dies between health checks.
let tokenRefreshTimer: NodeJS.Timeout | null = null;

// Refresh the access token on `connection`, update the live (mutable) config so
// every subsequent auth uses the new token, persist the rotated pair to .env, and
// re-arm the proactive timer from the reported lifetime.
async function doRefresh(connection: any): Promise<void> {
  const r = await refreshAccessToken(connection, cfg().refreshToken);
  cfg().accessToken = r.accessToken;
  cfg().refreshToken = r.refreshToken;
  persistTokens(r.accessToken, r.refreshToken);
  console.log(`[CTRADER] Access token refreshed (expires in ~${Math.round(r.expiresInSec / 3600)}h)`);
  scheduleProactiveRefresh(connection, r.expiresInSec);
}

// (Re)arm the proactive refresh at half the remaining lifetime (floor 5 min, cap
// 24h). Skipped when the broker reports no/unknown expiry. Kept independent of the
// health check so a healthy-but-aging token is renewed before it can lapse.
function scheduleProactiveRefresh(connection: any, expiresInSec: number): void {
  if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
  if (!expiresInSec || expiresInSec <= 0) return;
  const delayMs = Math.min(24 * 3600_000, Math.max(300_000, (expiresInSec * 1000) / 2));
  tokenRefreshTimer = setTimeout(async () => {
    try {
      // Refresh on the current live connection, not the (possibly stale) one this
      // timer was armed with; a reconnect may have replaced it since.
      await doRefresh(ctrader ?? connection);
    } catch (err: any) {
      console.warn(`[CTRADER] Proactive token refresh failed: ${err.errorCode || err.message || err}. Health check will recover via reconnect if the session dies.`);
    }
  }, delayMs);
}

// Authenticate ONE account, refreshing the access token once if the broker rejects
// it as expired/invalid. This is the recovery hinge: on reconnect after a token
// expiry, the first account-auth fails, we refresh with the (still-valid) refresh
// token, and retry, so the session comes back without a manual token re-issue.
//
// The account is passed in explicitly rather than read from module config: with
// several accounts on one connection, "the account" is no longer well defined.
// Token refresh mutates the shared config, so a refresh triggered while
// authenticating one account benefits every account authenticated after it.
async function authenticateAccount(connection: any, account: TradingAccount): Promise<void> {
  const authOnce = () => connection.sendCommand("ProtoOAAccountAuthReq", {
    ctidTraderAccountId: account.ctid,
    accessToken: cfg().accessToken,
  });
  try {
    await authOnce();
  } catch (err: any) {
    const code = String(err?.errorCode || "").toUpperCase();

    // The session we were asking for already exists. This is a SUCCESS, not a
    // failure: it happens whenever two recovery paths race for one account (a
    // disconnect event and a watchdog check, say), which multi-account makes a
    // normal occurrence rather than a rarity. Treating it as an error triggered a
    // needless token refresh, and since a refresh ROTATES the token, that
    // invalidated the grant for every other connection using it.
    if (code === "ALREADY_LOGGED_IN") {
      liveSessions.add(account.ctid);
      console.log(`[CTRADER] Account ${account.ctid} [${account.role}] already authenticated on this connection`);
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
    console.warn(`[CTRADER] Account auth rejected for ${account.ctid} [${account.role}] (${reason}); refreshing access token and retrying`);
    await doRefresh(connection);
    await authOnce();
  }
  liveSessions.add(account.ctid);
  console.log(`[CTRADER] Account authenticated: ${account.ctid} [${account.role}]`);
}

// Authenticate every configured account over the one connection. Each needs its
// own account-level auth request; an app-level token being valid does not
// establish an account session by itself.
//
// The PRIMARY account is the one the bot trades, so a failure there is fatal to
// the attempt and propagates (boot aborts, or reconnect retries with backoff).
// A non-primary account failing is logged and skipped: it carries no trading
// behaviour, and taking the whole bot down over it would make adding an account
// strictly riskier than not having one.
async function authenticateAllAccounts(connection: any): Promise<void> {
  for (const account of getAccounts()) {
    if (account.role === PRIMARY) {
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

// Re-establish ONE account's session on the existing socket, without tearing the
// connection down. This is what makes multi-account safe: the broker can drop a
// single account's session while the socket and every other account's session
// stay perfectly healthy, so the response must be scoped to that account.
// Rebuilding the whole connection here would turn one account's hiccup into an
// outage for all of them.
async function reauthAccount(account: TradingAccount, reason: string): Promise<void> {
  if (reconnecting || !ctrader) return; // a full reconnect will re-auth everyone anyway
  if (reauthInFlight.has(account.ctid)) return;
  reauthInFlight.add(account.ctid);
  liveSessions.delete(account.ctid);
  // The source account's session dropping is a copy-trade gap even though the
  // socket survives: fills landing before it is restored raise no event we see.
  if (account.role === SOURCE_ROLE) reportSourceGap(reason, null);
  try {
    console.warn(`[CTRADER] Re-authenticating ${account.ctid} [${account.role}] (${reason})`);
    await authenticateAccount(ctrader, account);
    // The primary account drives trading state, so its streams and positions must
    // be resynced after a gap; a non-primary session has none to restore.
    if (account.role === PRIMARY) {
      await resubscribeStreams();
      await reconcilePositions();
      console.log(`[CTRADER] ${account.ctid} [${account.role}] session restored; streams and positions re-synced`);
    } else {
      console.log(`[CTRADER] ${account.ctid} [${account.role}] session restored`);
    }
  } catch (err: any) {
    // A targeted re-auth failing means the problem is not scoped to this account
    // (dead socket, invalid token). Escalate to a full reconnect, which is the
    // path that rebuilds the socket and refreshes the token.
    console.warn(`[CTRADER] Targeted re-auth of ${account.ctid} failed: ${err.errorCode || err.message || err}; escalating to full reconnect`);
    await reconnect(`re-auth failed for account ${account.ctid}`);
  } finally {
    reauthInFlight.delete(account.ctid);
  }
}

// The broker announces a dying session with these push events (rather than
// dropping the socket). Catch them and recover immediately; otherwise the session
// stays dead until the next health check notices.
function installSessionListeners(connection: any): void {
  // Token invalidation is grant-wide: every account under this token is affected,
  // so this correctly stays a full reconnect (which also refreshes the token).
  connection.on("ProtoOAAccountsTokenInvalidatedEvent", (event: any) => {
    const d = event.descriptor ?? event;
    console.warn(`[CTRADER] Broker invalidated the token: ${d?.reason || "no reason given"}; refreshing + reconnecting`);
    reconnect("token invalidated by broker");
  });
  // A disconnect event names the account it applies to. Route on it and re-auth
  // just that account, leaving the socket and the other sessions untouched. When
  // the id is missing or unknown, fall back to the old full reconnect: an
  // unattributable disconnect is not safe to treat as narrowly scoped.
  connection.on("ProtoOAAccountDisconnectEvent", (event: any) => {
    const d = event.descriptor ?? event;
    const ctid = Number(d?.ctidTraderAccountId);
    const account = Number.isFinite(ctid) ? accountByCtid(ctid) : undefined;
    if (!account) {
      console.warn(`[CTRADER] Broker disconnected an unidentified account session (${d?.ctidTraderAccountId ?? "no id"}); reconnecting`);
      reconnect("account disconnected by broker");
      return;
    }
    reauthAccount(account, "disconnected by broker");
  });
}

// Open a socket, authenticate the application and account, and return the ready
// connection. Used for the first connect and every reconnect.
async function buildConnection(): Promise<any> {
  const connection = new CTraderConnection({
    host: cfg().host,
    port: cfg().port,
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
  console.log("[CTRADER] Socket opened");

  await connection.sendCommand("ProtoOAApplicationAuthReq", {
    clientId: cfg().clientId,
    clientSecret: cfg().clientSecret,
  });
  console.log("[CTRADER] Application authenticated");

  // Resolve configured accounts (login -> ctidTraderAccountId) before any
  // account-level auth. Cached after the first success, so this is a no-op on
  // every reconnect and adds no failure point to the recovery path.
  await resolveAccounts(connection, cfg().accessToken);

  // A fresh socket carries no account sessions, whatever the previous one had.
  liveSessions.clear();
  await authenticateAllAccounts(connection);
  installSessionListeners(connection);

  return connection;
}

// Point every module at `connection` and (re)start the keep-alive heartbeat. The
// setters store the reference in a module-level variable read fresh on each use,
// so calling them again after a reconnect transparently redirects everything.
function wireConnection(connection: any): void {
  ctrader = connection;
  setConnection(connection);
  setLivePriceConnection(connection);
  setAmendConnection(connection);
  setMidnightConnection(connection);
  setExportConnection(connection);
  setStatusConnection(connection);
  setMiniAppConnection(connection);

  // Re-attach the copy-trade subscriber to the new socket. Its listener lived on
  // the old connection and died with it, so without this a reconnect would leave
  // the source account silently unwatched.
  watchSourceAccount(connection);

  // cTrader drops the push channel if no message is sent for ~10s. Keep it alive.
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    try { connection.sendHeartbeat(); } catch { /* dead socket: watchdog reconnects */ }
  }, 10_000);
}

// (Re)subscribe every stream the bot relies on: spots for allowed symbols and open
// positions, plus the USD conversion pairs for any non-USD-quoted ones. A new socket
// starts with zero subscriptions, so reset the cache first.
async function resubscribeStreams(): Promise<void> {
  resetSpotSubscriptions();
  const allowedSymbolIds = [...new Set(
    state.settings.allowedSymbols
      .map((s) => symbolIdFor(s))
      .filter((id): id is number => id !== undefined)
  )];
  await subscribeSpots(allowedSymbolIds);
  await subscribeConversionPairs(state.settings.allowedSymbols);
  await subscribeOpenPositions();
  await subscribeConversionPairs([...state.positions.values()].map((p) => p.symbol));
}

// Tear down the dead connection and rebuild it end-to-end: re-auth, re-wire every
// module, re-subscribe streams, and re-adopt broker positions. Retries forever with
// backoff; a broker/network outage must not permanently wedge the bot. Guarded so
// overlapping health-check failures can't start two reconnects at once.
async function reconnect(reason: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  console.warn(`[CTRADER] Connection lost (${reason}); reconnecting`);

  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  // The socket is going away, so no account session survives it. Clear before
  // rebuilding so nothing reads a stale "live" session during the gap.
  liveSessions.clear();
  // From here until the subscriber is re-attached the source account is unwatched,
  // and fills in that window are lost (no backfill is possible on this API).
  reportSourceGap(reason, null);
  try { ctrader?.close?.(); } catch { /* already gone */ }

  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await buildConnection();
      wireConnection(connection);
      await resubscribeStreams();
      // Re-adopt open positions and refresh their broker-side SL/TP after the gap.
      await reconcilePositions();
      // Re-seed today's realized P&L from the broker. Closes that happened while
      // we were disconnected raise no execution event, so the in-memory counter
      // would silently understate the day and the loss limit would not bite when
      // it should. The broker's own figure is authoritative; take it.
      try {
        const seeded = await fetchTodayRealizedPnL(connection);
        if (seeded !== state.dailyRealizedPnL) {
          console.log(`[PNL] Re-seeded after reconnect: ${state.dailyRealizedPnL.toFixed(2)} -> ${seeded.toFixed(2)}`);
        }
        state.dailyRealizedPnL = seeded;
        state.dailyPnLSeeded = true;
        evaluateDailyLimits(true);
      } catch (err: any) {
        console.warn(`[PNL] Could not re-seed after reconnect: ${err.errorCode || err.message || "request failed"} (keeping in-memory figure)`);
      }
      console.log(`[CTRADER] Reconnected (attempt ${attempt}); streams and positions re-synced`);
      break;
    } catch (err: any) {
      const wait = Math.min(30_000, 2_000 * attempt);
      console.warn(`[CTRADER] Reconnect attempt ${attempt} failed: ${err.message || err}. Retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  reconnecting = false;
}

// First connect: build, authenticate, and wire everything. Returns the live
// connection for the boot sequence's direct use.
export async function startCTrader(): Promise<any> {
  const connection = await buildConnection();
  wireConnection(connection);
  return connection;
}

// Periodically prove the connection can still round-trip an ACCOUNT-scoped request.
// ProtoOATraderReq is market-independent (so it won't false-trigger on a quiet
// symbol) but, unlike the old app-level ProtoOAVersionReq, it exercises the account
// session itself: if the access token has expired the socket stays up and a version
// ping still succeeds, yet every real request (reconcile, margin, orders) fails. A
// failure here, timeout OR an auth/invalid error, triggers reconnect(), which
// re-auths and refreshes the token, bringing trading back without a manual restart.
// Each account is checked independently, because with several sessions on one
// socket a single account's failure no longer implies the connection is dead.
// The PRIMARY account is the connection's health proxy: if its check fails the
// bot cannot trade, so that escalates to a full reconnect exactly as before. A
// non-primary failure is scoped to that account and gets a targeted re-auth,
// which cannot disturb the primary session.
export function startConnectionWatchdog(): void {
  setInterval(async () => {
    if (reconnecting || !ctrader) return;
    for (const account of getAccounts()) {
      if (reconnecting || !ctrader) return; // a reconnect started mid-sweep; it re-auths everyone
      if (reauthInFlight.has(account.ctid)) continue;
      try {
        await ctrader.sendCommand("ProtoOATraderReq", { ctidTraderAccountId: account.ctid });
        liveSessions.add(account.ctid);
      } catch (err: any) {
        const detail = err.errorCode || err.message || err;
        if (account.role === PRIMARY) {
          await reconnect(`health check failed: ${detail}`);
          return;
        }
        await reauthAccount(account, `health check failed: ${detail}`);
      }
    }
  }, HEALTH_CHECK_MS);
  console.log(`[CTRADER] Connection watchdog active (per-account health check every ${HEALTH_CHECK_MS / 1000}s)`);
}

// Which accounts hold a live session right now. Exposed for status/diagnostics.
export function getLiveSessions(): number[] {
  return [...liveSessions];
}
