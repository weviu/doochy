import dotenv from "dotenv";
import { startPoller } from "../signals/poller";
import { state, initSettings, symbolIdFor } from "../state";
import { processSignal } from "../risk/gate";
import { fetchAccountInfo, fetchTodayRealizedPnL } from "../ctrader/account";
import { evaluateDailyLimits } from "../risk/dailyLoss";
import { fetchSymbols } from "../ctrader/symbols";
import { reconcilePositions } from "../ctrader/orders";
import { subscribeOpenPositions, subscribeSpots, subscribeConversionPairs } from "../ctrader/livePrices";
import { startCTrader, startConnectionWatchdog } from "../ctrader/lifecycle";
import { loadNewsConfig, startNewsMonitor } from "../risk/news";
import { loadTimeExitConfig, restoreTimedPositions, startTimeExitMonitor } from "../risk/timeExit";
import { startDailyReset } from "../risk/dailyLoss";
import { startCapMonitor } from "../risk/capMonitor";
import { startLossMonitor } from "../risk/lossMonitor";
import { startStopLossWatchdog } from "../risk/slWatchdog";
import { setNotifySink } from "../bot/notify";
import readline from "readline";
import { HubClient, hasSavedToken } from "./hubClient";
import { handleHubRequest } from "./handlers";

// DoochyBot entrypoint: the full trading engine (cTrader, risk gate, poller,
// every monitor) with the Telegram bot and local HTTP server replaced by one
// WebSocket link to the Hub. Runs on the VPS for the owner and on each
// friend's machine identically; only .env contents differ.
dotenv.config();

const HUB_WS_URL = process.env.HUB_WS_URL || "ws://127.0.0.1:9009/ws";

// First-run pairing code, from --code <code> or AGENT_PAIR_CODE. Ignored once
// data/doochybot-token.json exists.
const codeArgIdx = process.argv.indexOf("--code");
const PAIR_CODE = (codeArgIdx !== -1 ? process.argv[codeArgIdx + 1] : "") || process.env.AGENT_PAIR_CODE || "";

// Pair codes are 6 chars from an unambiguous alphabet (no 0/O/1/I); see the
// Hub's registry. Validate against it so a mistyped or half-captured line is
// rejected at the prompt instead of sent to the Hub as an "invalid code".
const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// First run in a terminal: no saved token, no code given. Ask instead of
// erroring out, so setup is just "start it and type the code from /pair".
// Non-interactive runs (pm2) never prompt; they still need --code or the env.
//
// We do NOT use rl.question: under tsx (notably on Windows, and after the
// wizard's `pnpm build` runs first) a line typed before we start awaiting is
// flushed while question isn't listening and is silently lost, so the code line
// vanishes and only a later blank line is seen. Instead a persistent line
// listener queues every line the moment it arrives, and readLine() hands them
// out one at a time. An empty/malformed entry re-asks; closed stdin returns ""
// so the caller can print the env-var fallback instead of hanging.
async function promptForPairCode(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waiter) { const w = waiter; waiter = null; w(line); }
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) { const w = waiter; waiter = null; w(null); }
  });

  const readLine = (): Promise<string | null> => {
    if (queued.length > 0) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => { waiter = resolve; });
  };

  try {
    for (;;) {
      process.stdout.write("Send /pair to @DoochyBot in Telegram, then enter the 6-character code here: ");
      const raw = await readLine();

      if (raw === null) {
        console.error(
          "\n[HUB-LINK] No code entered (input closed). Restart with the code from /pair, e.g.\n" +
          "  AGENT_PAIR_CODE=YOURCODE pnpm doochybot:start   (or --code YOURCODE)"
        );
        return "";
      }

      const code = raw.trim().toUpperCase();
      if (PAIR_CODE_RE.test(code)) return code;

      if (code.length === 0) {
        console.log("Nothing entered. Paste the 6-character code from /pair (it expires after 5 minutes).");
      } else {
        console.log(`"${code}" is not a valid pairing code (expected 6 characters: A-Z and 2-9). Try again.`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  console.log("[BOOT] Starting DoochyBot Agent...");
  initSettings();
  loadNewsConfig();
  loadTimeExitConfig();

  // Phase 2 parallel testing: run the whole engine but never act on signals,
  // so this agent can coexist with the legacy bot on the same account. Remove
  // the env var at cutover.
  if (process.env.AGENT_START_PAUSED === "1") {
    state.paused = true;
    console.warn("[BOOT] AGENT_START_PAUSED=1: trading is paused; /resume (via the Hub) or unset the env to trade");
  }

  let pairCode = PAIR_CODE;
  const needsPairing = !hasSavedToken() && !pairCode;
  if (needsPairing && process.stdin.isTTY) {
    pairCode = await promptForPairCode();
  }

  // The Hub link starts before the broker connection so pairing/auth and
  // command relays work even while cTrader is still coming up; handlers that
  // need the connection degrade gracefully until it is wired. But if we still
  // have no way to authenticate (no token, no code, and either non-interactive
  // or the prompt yielded nothing), don't start the link: it would just loop on
  // "no saved token and no pair code". Say how to fix it and skip the hub link
  // so the local trading engine still runs.
  let hub: HubClient | null = null;
  if (hasSavedToken() || pairCode) {
    hub = new HubClient(HUB_WS_URL, pairCode, handleHubRequest);
    setNotifySink((message) => hub!.notify(message));
    hub.start();
  } else {
    console.error(
      "[HUB-LINK] Not paired and no code provided; the Hub link is OFF (Telegram control and the mini-app will not reach this agent).\n" +
      "  Get a code with /pair in @DoochyBot, then restart within 5 minutes:\n" +
      "  AGENT_PAIR_CODE=YOURCODE pnpm doochybot:start   (or --code YOURCODE)"
    );
  }

  const connection = await startCTrader();
  startDailyReset();
  startCapMonitor();
  startLossMonitor();
  startStopLossWatchdog();
  console.log("[SAFETY] Daily reset, loss monitor, and SL watchdog active");
  await fetchAccountInfo(connection);
  await fetchSymbols(connection);

  // Scheduled-news guard: fetch the economic calendar and start the refresh +
  // pre-news flatten loop. After fetchSymbols so cancelRestingOrdersForSymbol
  // can resolve symbolIds; the connection is already wired, so the flatten's
  // closes/cancels can reach the broker.
  await startNewsMonitor();

  // Pre-subscribe spot streams for every allowed symbol so a live quote is
  // already flowing before the first signal arrives. Without this, the first
  // trade on a symbol has no mark price and risk-based sizing can't size
  // against it.
  const allowedSymbolIds = [...new Set(
    state.settings.allowedSymbols
      .map((s) => symbolIdFor(s))
      .filter((id): id is number => id !== undefined)
  )];
  await subscribeSpots(allowedSymbolIds);
  console.log(`[BOOT] Pre-subscribed spots for ${allowedSymbolIds.length} allowed symbol(s)`);

  // And the USD conversion pairs for any non-USD-quoted allowed symbol, so a
  // quote-to-USD rate is already warm before the first trade or valuation.
  await subscribeConversionPairs(state.settings.allowedSymbols);

  // Seed today's realized P&L from the broker BEFORE reconciling positions:
  // reconcilePositions() re-arms TPs on positions opened before the restart,
  // and the cap-TP logic only applies when dailyPnLSeeded is true. Retry once;
  // if both attempts fail, daily limits are disabled rather than run against a
  // false 0.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      state.dailyRealizedPnL = await fetchTodayRealizedPnL(connection);
      state.dailyPnLSeeded = true;
      console.log(`[PNL] Seeded today's realized P&L: ${state.dailyRealizedPnL.toFixed(2)}`);
      break;
    } catch (err: any) {
      console.warn(`[PNL] Seed attempt ${attempt} failed: ${err.errorCode || err.message || "request failed"}`);
      if (attempt === 2) {
        console.warn("[PNL] Daily loss/profit limits DISABLED this session: could not read today's P&L from broker.");
      }
    }
  }

  await reconcilePositions();
  // Re-attach persisted time-exit timers to positions the broker just gave us
  // back, so a timed position opened before a restart still time-closes on
  // schedule. Must run AFTER reconcile.
  restoreTimedPositions();
  startTimeExitMonitor();
  // Stream live prices and conversion pairs for positions we already hold so
  // floating P&L and the profit cap are accurate immediately.
  await subscribeOpenPositions();
  await subscribeConversionPairs([...state.positions.values()].map((p) => p.symbol));
  evaluateDailyLimits(false);
  startConnectionWatchdog();

  startPoller((signal) => {
    processSignal(signal);
  });
  console.log("[BOOT] Agent ready");
}

main().catch((err) => {
  console.error("[BOOT] Fatal error:", err);
  process.exit(1);
});
