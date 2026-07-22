import dotenv from "dotenv";
import path from "path";
import { Registry } from "./registry";
import { startHubServer } from "./server";
import { startHubBot } from "./bot";
import { initHubAuth } from "./auth";
import { getOwnerId, getUsers } from "./db";

// Hub entrypoint. Configuration comes exclusively from .env.hub so phase 1
// (test bot token, port 9010) and the phase 3 cutover (real token, port 9009)
// differ only in env values, never in code.
dotenv.config({ path: path.join(process.cwd(), ".env.hub") });

const PORT = parseInt(process.env.HUB_PORT || "9010");
const BOT_TOKEN = process.env.HUB_BOT_TOKEN || "";

function main(): void {
  console.log("[HUB] Starting DoochyBot Hub...");

  const users = Object.values(getUsers());
  if (users.length === 0) {
    console.warn("[HUB] data/users.json is empty. Nobody can pair or use the bot until users are added.");
  } else {
    console.log(`[HUB] ${users.length} user(s) loaded: ${users.map((u) => `${u.name}(${u.role})`).join(", ")}`);
  }

  const registry = new Registry();
  // Mini-app initData is signed with the bot token; without it /api can only 401.
  initHubAuth(BOT_TOKEN);
  startHubServer(registry, PORT);

  if (BOT_TOKEN) {
    try {
      startHubBot(BOT_TOKEN, registry);
    } catch (err: any) {
      console.warn(`[HUB] Telegram bot failed to start: ${err.message}. WS and API stay up; fix HUB_BOT_TOKEN and restart.`);
    }
  } else {
    console.warn("[HUB] HUB_BOT_TOKEN not set; running without Telegram. WS and API are still live.");
  }

  // Dev-only: pre-seed a pairing code for the owner so the WS pipe can be
  // tested end to end before the Telegram bot is configured.
  const devCode = process.env.HUB_DEV_PAIR_CODE || "";
  if (devCode) {
    const ownerId = getOwnerId();
    if (ownerId !== undefined) {
      registry.seedDevPairCode(devCode, ownerId);
      console.warn(`[HUB] DEV PAIR CODE ACTIVE ("${devCode}" pairs as the owner). Never set HUB_DEV_PAIR_CODE in production.`);
    }
  }

  console.log("[HUB] Ready");
}

main();
