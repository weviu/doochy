import dotenv from "dotenv";
import { Bot } from "grammy";
import { startPoller } from "./signals/poller";
import { state, initSettings, symbolIdFor } from "./state";
import { processSignal } from "./risk/gate";
import { pauseCmd } from "./bot/commands/pause";
import { resumeCmd } from "./bot/commands/resume";
import { symbolsCmd } from "./bot/commands/symbols";
import { riskCmd } from "./bot/commands/risk";
import { minholdCmd } from "./bot/commands/minhold";
import { closeallCmd } from "./bot/commands/closeall";
import { exportCmd } from "./bot/commands/export";
import { statusCmd } from "./bot/commands/status";
import { settingsCmd } from "./bot/commands/settings";
import { notificationsCmd } from "./bot/commands/notifications";
import { cooldownCmd } from "./bot/commands/cooldown";
import { positionsCmd } from "./bot/commands/positions";
import { orderCmd } from "./bot/commands/order";
import { fetchAccountInfo, fetchTodayRealizedPnL } from "./ctrader/account";
import { evaluateDailyLimits } from "./risk/dailyLoss";
import { fetchSymbols } from "./ctrader/symbols";
import { reconcilePositions } from "./ctrader/orders";
import { subscribeOpenPositions, subscribeSpots, subscribeConversionPairs } from "./ctrader/livePrices";
import { startCTrader, startConnectionWatchdog } from "./ctrader/lifecycle";
import { loadNewsConfig, startNewsMonitor } from "./risk/news";
import { loadTimeExitConfig, restoreTimedPositions, startTimeExitMonitor } from "./risk/timeExit";
import { startDailyReset } from "./risk/dailyLoss";
import { startCapMonitor } from "./risk/capMonitor";
import { startLossMonitor } from "./risk/lossMonitor";
import { startStopLossWatchdog } from "./risk/slWatchdog";
import { setNotifier } from "./bot/notify";
import { startWebhookServer } from "./webhook";
import { initMiniAppAuth } from "./miniapp/auth";

dotenv.config();

// The cTrader connection lifecycle (connect, auth, token refresh, reconnect,
// watchdog) lives in ctrader/lifecycle.ts, shared with the Agent entrypoint.

const telegram = {
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  allowedUsers: (process.env.ALLOWED_USERS || "").split(",").map(Number),
};

async function startBot() {
  const bot = new Bot(telegram.token);
  setNotifier(bot, telegram.allowedUsers);
  // The Mini App validates its initData signature with the bot token and gates
  // access to the same allowed users as the chat commands.
  initMiniAppAuth(telegram.token, telegram.allowedUsers);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && telegram.allowedUsers.length > 0) {
      if (!telegram.allowedUsers.includes(userId)) {
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
const connection = await startCTrader();
startDailyReset();
startCapMonitor();
startLossMonitor();
startStopLossWatchdog();
console.log("[SAFETY] Daily reset, loss monitor, and SL watchdog active");
await fetchAccountInfo(connection);
await fetchSymbols(connection);

// Scheduled-news guard (gold today): fetch the economic calendar and start the
// refresh + pre-news flatten loop. After fetchSymbols so cancelRestingOrdersForSymbol
// can resolve symbolIds; the connection is already wired (startCTrader above), so
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
    state.dailyRealizedPnL = await fetchTodayRealizedPnL(connection);
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
