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
  accountId: string;
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
      accountId: process.env.ACCOUNT_ID || "",
    };
  }
  return config;
}

// The current live connection. Every module points at this via its setter; on
// reconnect we build a new one and re-run the setters so they all follow.
let ctrader: any = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnecting = false;

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

// Authenticate the account, refreshing the access token once if the broker rejects
// it as expired/invalid. This is the recovery hinge: on reconnect after a token
// expiry, the first account-auth fails, we refresh with the (still-valid) refresh
// token, and retry, so the session comes back without a manual token re-issue.
async function authenticateAccount(connection: any): Promise<void> {
  const authOnce = () => connection.sendCommand("ProtoOAAccountAuthReq", {
    ctidTraderAccountId: parseInt(cfg().accountId),
    accessToken: cfg().accessToken,
  });
  try {
    await authOnce();
  } catch (err: any) {
    // Only refresh on a broker-reported auth/token error (errorCode/description),
    // not a bare socket timeout: a timeout means a dead link that a refresh can't
    // fix, so let it propagate and have reconnect() rebuild the socket instead.
    const reason = `${err?.errorCode || ""} ${err?.description || ""}`.trim();
    if (!reason || !/token|auth|expire|invalid/i.test(reason)) throw err;
    console.warn(`[CTRADER] Account auth rejected (${reason}); refreshing access token and retrying`);
    await doRefresh(connection);
    await authOnce();
  }
  console.log("[CTRADER] Account authenticated");
}

// The broker announces a dying account session with these push events (rather than
// dropping the socket). Catch them and drive a refresh+reconnect immediately;
// otherwise the session stays dead until the next health check notices.
function installSessionListeners(connection: any): void {
  connection.on("ProtoOAAccountsTokenInvalidatedEvent", (event: any) => {
    const d = event.descriptor ?? event;
    console.warn(`[CTRADER] Broker invalidated the token: ${d?.reason || "no reason given"}; refreshing + reconnecting`);
    reconnect("token invalidated by broker");
  });
  connection.on("ProtoOAAccountDisconnectEvent", () => {
    console.warn("[CTRADER] Broker disconnected the account session; reconnecting");
    reconnect("account disconnected by broker");
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

  await authenticateAccount(connection);
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
export function startConnectionWatchdog(): void {
  setInterval(async () => {
    if (reconnecting || !ctrader) return;
    try {
      await ctrader.sendCommand("ProtoOATraderReq", {
        ctidTraderAccountId: parseInt(cfg().accountId),
      });
    } catch (err: any) {
      await reconnect(`health check failed: ${err.errorCode || err.message || err}`);
    }
  }, HEALTH_CHECK_MS);
  console.log(`[CTRADER] Connection watchdog active (account health check every ${HEALTH_CHECK_MS / 1000}s)`);
}
