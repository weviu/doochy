import dotenv from "dotenv";
import { initSettings } from "../state";
import { startCTrader, startConnectionWatchdog } from "../ctrader/lifecycle";
import { fetchSymbols } from "../ctrader/symbols";
import { getAccounts } from "../ctrader/accounts";

// Copy-trade SOURCE NODE: a standalone process whose ONLY job is to watch one
// account traded by hand (via Autochartist) and broadcast its fills into the
// alerts feed. It deliberately does NOT run the trading engine.
//
// Why a separate entrypoint instead of a flag on the main bot: the main
// doochybot boot starts the risk monitors (loss, profit cap, SL watchdog),
// reconcilePositions (which re-arms broker-side SL/TP), the news pre-flatten, the
// time-exit monitor, and the feed poller. Every one of those MANAGES positions.
// Pointed at a hand-traded account they would close or overwrite the human's own
// Autochartist trades. This node runs none of them: it connects, authenticates
// the source account, loads symbols so fills can be named, watches for fills, and
// writes/POSTs alerts. Nothing here can place, close, or modify an order.
dotenv.config();

async function main() {
  console.log("[SOURCE-NODE] Starting copy-trade source node (watch only, no trading)...");

  // Refuse to run without the flag: it is what makes the account registry accept a
  // config with no "primary", and it is the contract that guarantees this process
  // never trades. Booting without it would mean a misconfiguration, not this mode.
  if (process.env.COPYTRADE_SOURCE_ONLY !== "1") {
    console.error("[SOURCE-NODE] COPYTRADE_SOURCE_ONLY must be set to 1 to run the source node. Refusing to start.");
    process.exit(1);
  }

  // Settings are read by shared code paths (e.g. symbol handling); load them so
  // nothing reads an uninitialised default. No trading behaviour is started here.
  initSettings();

  // Connect, app-auth, resolve + authenticate the source account, and wire the
  // fill watcher (wireConnection attaches it). No monitors, no poller.
  const connection = await startCTrader();

  // Load the symbol map so the watcher can turn a fill's symbolId into a name.
  // Uses the source account itself (primaryAccountId() falls back to it in this
  // mode), which is on the same broker, so the ids line up.
  await fetchSymbols(connection);

  // Keep the session alive and reconnect on drop. For a source-role account a
  // health-check failure triggers a targeted re-auth (never a position reconcile),
  // and every reconnect re-attaches the watcher.
  startConnectionWatchdog();

  const watched = getAccounts().map((a) => `${a.ctid} [${a.role}]`).join(", ");
  console.log(`[SOURCE-NODE] Ready. Watching ${watched} for Autochartist fills. No positions are managed by this process.`);
}

main().catch((err) => {
  console.error("[SOURCE-NODE] Fatal error:", err);
  process.exit(1);
});
