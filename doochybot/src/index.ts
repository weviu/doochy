import dotenv from "dotenv";
import { Bot } from "grammy";
import { CTraderConnection } from "@reiryoku/ctrader-layer";
import { startPoller } from "./signals/poller";
import { state, initSettings, symbolIdFor } from "./state";
import { processSignal } from "./risk/gate";
import { pauseCmd } from "./bot/commands/pause";
import { resumeCmd } from "./bot/commands/resume";
import { symbolsCmd } from "./bot/commands/symbols";
import { riskCmd } from "./bot/commands/risk";
import { minholdCmd } from "./bot/commands/minhold";
import { closeallCmd } from "./bot/commands/closeall";
import { exportCmd, setExportConnection } from "./bot/commands/export";
import { statusCmd, setStatusConnection } from "./bot/commands/status";
import { settingsCmd } from "./bot/commands/settings";
import { notificationsCmd } from "./bot/commands/notifications";
import { cooldownCmd } from "./bot/commands/cooldown";
import { positionsCmd } from "./bot/commands/positions";
import { orderCmd } from "./bot/commands/order";
import { fetchAccountInfo, fetchTodayRealizedPnL } from "./ctrader/account";
import { evaluateDailyLimits } from "./risk/dailyLoss";
import { fetchSymbols } from "./ctrader/symbols";
import { setConnection, reconcilePositions } from "./ctrader/orders";
import { setLivePriceConnection, subscribeOpenPositions, subscribeSpots, subscribeConversionPairs, resetSpotSubscriptions } from "./ctrader/livePrices";
import { setAmendConnection } from "./ctrader/amend";
import { setMidnightConnection } from "./risk/midnightClose";
import { loadNewsConfig, startNewsMonitor } from "./risk/news";
import { loadTimeExitConfig, restoreTimedPositions, startTimeExitMonitor } from "./risk/timeExit";
import { startDailyReset } from "./risk/dailyLoss";
import { startCapMonitor } from "./risk/capMonitor";
import { startLossMonitor } from "./risk/lossMonitor";
import { startStopLossWatchdog } from "./risk/slWatchdog";
import { setNotifier } from "./bot/notify";
import { startWebhookServer } from "./webhook";
import { refreshAccessToken, persistTokens } from "./ctrader/token";

dotenv.config();

const config = {
  ctrader: {
    host: process.env.CTRADER_HOST || "demo.ctraderapi.com",
    port: parseInt(process.env.CTRADER_PORT || "5035"),
    clientId: process.env.CLIENT_ID || "",
    clientSecret: process.env.CLIENT_SECRET || "",
    accessToken: process.env.ACCESS_TOKEN || "",
    refreshToken: process.env.REFRESH_TOKEN || "",
    accountId: process.env.ACCOUNT_ID || "",
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedUsers: (process.env.ALLOWED_USERS || "").split(",").map(Number),
  },
};

// How long any single broker request may wait for its response before we treat it
// as failed. The @reiryoku/ctrader-layer has NO request timeout and its socket
// close/error handlers are no-ops, so a silently dropped connection (which does
// happen — the TCP link dies with no FIN/RST) would otherwise leave every await
// pending forever: the bot keeps running but never trades again until restarted.
const REQUEST_TIMEOUT_MS = 15_000;
// Health check cadence. Every tick we send a trivial request; if it times out the
// connection is dead and we reconnect.
const HEALTH_CHECK_MS = 20_000;

// The current live connection. Every module points at this via its setter; on
// reconnect we build a new one and re-run the setters so they all follow.
let ctrader: any = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnecting = false;

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
// again at ~50% of the remaining life — well before expiry, so the account
// session never silently dies between health checks.
let tokenRefreshTimer: NodeJS.Timeout | null = null;

// Refresh the access token on `connection`, update the live (mutable) config so
// every subsequent auth uses the new token, persist the rotated pair to .env, and
// re-arm the proactive timer from the reported lifetime.
async function doRefresh(connection: any): Promise<void> {
  const r = await refreshAccessToken(connection, config.ctrader.refreshToken);
  config.ctrader.accessToken = r.accessToken;
  config.ctrader.refreshToken = r.refreshToken;
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
      // timer was armed with — a reconnect may have replaced it since.
      await doRefresh(ctrader ?? connection);
    } catch (err: any) {
      console.warn(`[CTRADER] Proactive token refresh failed: ${err.errorCode || err.message || err}. Health check will recover via reconnect if the session dies.`);
    }
  }, delayMs);
}

// Authenticate the account, refreshing the access token once if the broker rejects
// it as expired/invalid. This is the recovery hinge: on reconnect after a token
// expiry, the first account-auth fails, we refresh with the (still-valid) refresh
// token, and retry — so the session comes back without a manual token re-issue.
async function authenticateAccount(connection: any): Promise<void> {
  const authOnce = () => connection.sendCommand("ProtoOAAccountAuthReq", {
    ctidTraderAccountId: parseInt(config.ctrader.accountId),
    accessToken: config.ctrader.accessToken,
  });
  try {
    await authOnce();
  } catch (err: any) {
    // Only refresh on a broker-reported auth/token error (errorCode/description),
    // not a bare socket timeout — a timeout means a dead link that a refresh can't
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
// dropping the socket). Catch them and drive a refresh+reconnect immediately —
// otherwise the session stays dead until the next health check notices.
function installSessionListeners(connection: any): void {
  connection.on("ProtoOAAccountsTokenInvalidatedEvent", (event: any) => {
    const d = event.descriptor ?? event;
    console.warn(`[CTRADER] Broker invalidated the token: ${d?.reason || "no reason given"} — refreshing + reconnecting`);
    reconnect("token invalidated by broker");
  });
  connection.on("ProtoOAAccountDisconnectEvent", (event: any) => {
    console.warn("[CTRADER] Broker disconnected the account session — reconnecting");
    reconnect("account disconnected by broker");
  });
}

// Open a socket, authenticate the application and account, and return the ready
// connection. Used for the first connect and every reconnect.
async function buildConnection(): Promise<any> {
  const connection = new CTraderConnection({
    host: config.ctrader.host,
    port: config.ctrader.port,
  });

  await connection.open();
  installRequestTimeout(connection);
  console.log("[CTRADER] Socket opened");

  await connection.sendCommand("ProtoOAApplicationAuthReq", {
    clientId: config.ctrader.clientId,
    clientSecret: config.ctrader.clientSecret,
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

  // cTrader drops the push channel if no message is sent for ~10s. Keep it alive.
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    try { connection.sendHeartbeat(); } catch { /* dead socket — watchdog reconnects */ }
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
// backoff — a broker/network outage must not permanently wedge the bot. Guarded so
// overlapping health-check failures can't start two reconnects at once.
async function reconnect(reason: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  console.warn(`[CTRADER] Connection lost (${reason}) — reconnecting`);

  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try { ctrader?.close?.(); } catch { /* already gone */ }

  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await buildConnection();
      wireConnection(connection);
      await resubscribeStreams();
      // Re-adopt open positions and refresh their broker-side SL/TP after the gap.
      await reconcilePositions();
      console.log(`[CTRADER] Reconnected (attempt ${attempt}) — streams and positions re-synced`);
      break;
    } catch (err: any) {
      const wait = Math.min(30_000, 2_000 * attempt);
      console.warn(`[CTRADER] Reconnect attempt ${attempt} failed: ${err.message || err}. Retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  reconnecting = false;
}

// Periodically prove the connection can still round-trip an ACCOUNT-scoped request.
// ProtoOATraderReq is market-independent (so it won't false-trigger on a quiet
// symbol) but, unlike the old app-level ProtoOAVersionReq, it exercises the account
// session itself: if the access token has expired the socket stays up and a version
// ping still succeeds, yet every real request (reconcile, margin, orders) fails. A
// failure here — timeout OR an auth/invalid error — triggers reconnect(), which
// re-auths and refreshes the token, bringing trading back without a manual restart.
function startConnectionWatchdog(): void {
  setInterval(async () => {
    if (reconnecting || !ctrader) return;
    try {
      await ctrader.sendCommand("ProtoOATraderReq", {
        ctidTraderAccountId: parseInt(config.ctrader.accountId),
      });
    } catch (err: any) {
      await reconnect(`health check failed: ${err.errorCode || err.message || err}`);
    }
  }, HEALTH_CHECK_MS);
  console.log(`[CTRADER] Connection watchdog active (account health check every ${HEALTH_CHECK_MS / 1000}s)`);
}

async function startBot() {
  const bot = new Bot(config.telegram.token);
  setNotifier(bot, config.telegram.allowedUsers);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && config.telegram.allowedUsers.length > 0) {
      if (!config.telegram.allowedUsers.includes(userId)) {
        await ctx.reply("Unauthorized");
        return;
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("DoochyBot running.\nNew here? Send /guide to set up trading, or /help for all commands.");
  });

  bot.command("guide", async (ctx) => {
    await ctx.reply(
      "HOW TO START TRADING\n" +
      "\n" +
      "1. Set your risk per trade (REQUIRED)\n" +
      "Nothing trades until this is set. It is the max $ you lose if a trade's stop is hit; the bot sizes every position to match.\n" +
      "   /risk pertrade 50\n" +
      "\n" +
      "2. Nothing to set for SL/TP\n" +
      "Each signal carries its own stop and target; the bot sizes the trade to that stop so a hit loses ~your pertrade amount. A signal with no SL/TP is skipped.\n" +
      "\n" +
      "3. Choose which symbols to trade\n" +
      "   /symbols  (show current list)\n" +
      "   /symbols add XAUUSD\n" +
      "\n" +
      "4. Set daily safety limits (recommended)\n" +
      "Each one force-closes everything and stops trading for the day when hit.\n" +
      "   /risk maxloss 200  (daily loss limit)\n" +
      "   /risk cap 300      (daily profit cap, 0 = off)\n" +
      "\n" +
      "5. Confirm it is live\n" +
      "   /resume  (only if you previously paused)\n" +
      "   /status  (Sizing should show your $ risk, not 'not set')\n" +
      "\n" +
      "Done. Signals will now execute. See /help for the full command list."
    );
  });

bot.command("help", async (ctx) => {
  await ctx.reply(
    "• CONTROL\n" +
    "/pause: stop executing signals\n" +
    "/resume: resume executing signals\n" +
    "\n" +
    "• SYMBOLS\n" +
    "/symbols: list allowed symbols\n" +
    "/symbols add <sym>: add a symbol\n" +
    "/symbols add all: add all high confidence symbols\n" +
    "/symbols remove <sym>: remove a symbol\n" +
    "/symbols reset: restore default list\n" +
    "\n" +
    "• SIZING (how big each trade is)\n" +
    "/risk pertrade <usd>: max $ you lose if a trade's stop is hit; the bot sizes the lots to match (0 = trading off)\n" +
    "/risk overrun <pct>: how far over pertrade a trade may go when the broker's min lot forces it (0 = strict, default 20)\n" +
    "\n" +
    "• STOP / TARGET\n" +
    "SL/TP come from the signal itself (scanner, channel, or manual). The trade is sized so the distance to that stop loses ~your pertrade amount; a signal with no SL/TP is skipped.\n" +
    "/minhold <secs>: min hold before TP arms\n" +
    "\n" +
    "• DAILY LIMITS (both force close ALL positions + stop for the day)\n" +
    "/risk maxloss <usd>: daily loss limit\n" +
    "/risk cap <usd>: daily profit cap (0 = off)\n" +
    "/risk capbuffer <usd>: trigger cap this many $ early\n" +
    "/risk maxpos <n>: max concurrent positions\n" +
    "/risk combined <usd>: max summed risk across same symbol+direction positions (0 = off)\n" +
    "/risk confidence <n>: confidence given to channel signals (0-100), for reversal flips (default 69)\n" +
    "/risk minconfidence <n>: reject feed signals below this score (0-100); channel signals bypass (0 = off, default 50)\n" +
    "/risk btcbias on|off | bearish <n> | strongbearish <n>: suppress crypto BUYs when BTC is bearish unless confidence clears the floor (default on, 80 BEARISH / 90 BEARISH_STRONG)\n" +
    "/risk marginaware on|off: cap order size to fit free margin (default off)\n" +
    "\n" +
    "• COOLDOWN (per symbol loss streak)\n" +
    "/risk losses <n>: SL hits before cooldown (0 = off)\n" +
    "/risk losswindow <min>: window to count hits\n" +
    "/risk cooldown <min>: pause length\n" +
    "/risk reentry <min>: after a losing close, block reopening the same symbol+direction this long (0 = off)\n" +
    "/cooldown: list cooled down symbols\n" +
    "/cooldown reset [sym]: clear a cooldown (or all)\n" +
    "\n" +
    "• POSITIONS & INFO\n" +
    "/status: connection, P&L, limits, sizing, cooldowns\n" +
    "/settings: show all your configured settings\n" +
    "/notifications on|off: message me when an order fills\n" +
    "/notifications signals on|off: message me on every incoming signal (to trade manually elsewhere)\n" +
    "/notifications signals min <0-100>: only notify on signals at/above this score\n" +
    "/positions: open positions: entry, mark, SL, TP, P&L\n" +
    "/closeall: close all open positions\n" +
    "\n" +
    "/export [from] [to]: export trade history\n" +
    "\n" +
    "• MANUAL ORDERS\n" +
    "Market: BUY|SELL <symbol> <lots> <TP> <SL>\n" +
    "Limit:  BUY|SELL <symbol> <lots> <entry> <TP> <SL>\n" +
    "TP/SL are absolute prices. Symbol must be on your allowed list. Bypasses the signal gate and risk sizing.\n" +
    "\n" +
    "Notes: trade size comes from pertrade + the SL %. One position per symbol. Opposite signals flip only on higher confidence."
  );
});

  bot.command("pause", pauseCmd);
  bot.command("resume", resumeCmd);
  bot.command("symbols", symbolsCmd);
  bot.command("risk", riskCmd);
  bot.command("minhold", minholdCmd);
  bot.command("closeall", closeallCmd);
  bot.command("export", exportCmd);
  bot.command("status", statusCmd);
  bot.command("settings", settingsCmd);
  bot.command("notifications", notificationsCmd);
  bot.command("cooldown", cooldownCmd);
  bot.command("positions", positionsCmd);
  // Manual orders are typed without a slash ("SELL XAUUSD 0.02 3950 4010"), so
  // match the leading BUY/SELL instead of registering a command.
  bot.hears(/^\s*(buy|sell)\b/i, orderCmd);
  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("[TELEGRAM] Bot started"),
  });
}

async function main() {
  console.log("[BOOT] Starting DoochyBot...");
  initSettings();
  loadNewsConfig();
  loadTimeExitConfig();
const connection = await buildConnection();
wireConnection(connection);
startDailyReset();
startCapMonitor();
startLossMonitor();
startStopLossWatchdog();
console.log("[SAFETY] Daily reset, loss monitor, and SL watchdog active");
await fetchAccountInfo(ctrader);
await fetchSymbols(ctrader);

// Scheduled-news guard (gold today): fetch the economic calendar and start the
// refresh + pre-news flatten loop. After fetchSymbols so cancelRestingOrdersForSymbol
// can resolve symbolIds; the connection is already wired (wireConnection above), so
// the flatten's closes/cancels can reach the broker.
await startNewsMonitor();

// Pre-subscribe spot streams for every allowed symbol so a live quote is already
// flowing before the first signal arrives. Without this, the first trade on a
// symbol has no mark price and risk-based sizing can't size against it.
const allowedSymbolIds = [...new Set(
  state.settings.allowedSymbols
    .map((s) => symbolIdFor(s))
    .filter((id): id is number => id !== undefined)
)];
await subscribeSpots(allowedSymbolIds);
console.log(`[BOOT] Pre-subscribed spots for ${allowedSymbolIds.length} allowed symbol(s)`);

// Also stream the USD conversion pairs (USDJPY, USDCAD, ...) for any non-USD-quoted
// allowed symbol, so a quote-to-USD rate is already warm before the first trade or
// valuation. Without this, a GBPJPY signal would be refused (no rate) at first sight.
await subscribeConversionPairs(state.settings.allowedSymbols);

// Seed today's realized P&L from the broker BEFORE reconciling positions. This
// order is critical: reconcilePositions() re-arms TPs on positions opened before
// the restart, and the cap-TP logic in amend.ts only applies when dailyPnLSeeded
// is true. Seeding first means re-armed TPs are correctly capped to the remaining
// headroom instead of a full normal TP that could blow past the cap. Retry once;
// if both attempts fail, daily limits are disabled rather than run against a false 0.
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    state.dailyRealizedPnL = await fetchTodayRealizedPnL(ctrader);
    state.dailyPnLSeeded = true;
    console.log(`[PNL] Seeded today's realized P&L: ${state.dailyRealizedPnL.toFixed(2)}`);
    break;
  } catch (err: any) {
    console.warn(`[PNL] Seed attempt ${attempt} failed: ${err.errorCode || err.message || "request failed"}`);
    if (attempt === 2) {
      console.warn("[PNL] Daily loss/profit limits DISABLED this session — could not read today's P&L from broker.");
    }
  }
}

await reconcilePositions();
// Re-attach persisted time-exit timers to positions the broker just gave us back,
// so a timed position opened before a restart still time-closes on schedule (the
// broker doesn't return our time_exit_min metadata). Must run AFTER reconcile.
restoreTimedPositions();
startTimeExitMonitor();
// Start streaming live prices for any position we already hold so floating P&L
// and the profit cap are accurate immediately, not just after the next signal.
await subscribeOpenPositions();
// And the conversion pairs for any non-USD-quoted position we just reconciled, so
// its floating P&L converts to USD from the first monitor tick after restart.
await subscribeConversionPairs([...state.positions.values()].map((p) => p.symbol));
evaluateDailyLimits(false);
// Watch the broker link and auto-reconnect if it silently dies. Without this a
// dropped connection (which the cTrader layer never surfaces) leaves the bot alive
// but unable to trade — every order request hangs — until a manual restart.
startConnectionWatchdog();
await startBot();
    startPoller((signal) => {
    processSignal(signal);
  });
  startWebhookServer();
  console.log("[BOOT] Ready");
}

main().catch((err) => {
  console.error("[BOOT] Fatal error:", err);
  process.exit(1);
});
