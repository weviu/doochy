import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { TelegramClient, Api, utils } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";

import { SignalParser } from "./parser";
import { parseFxoroSignal } from "./parsers/fxoro";
import { sendSignal } from "./webhook";

/**
 * Minimal .env loader — keeps `telegram` (gramJS) as the only runtime dependency.
 * Reads KEY=VALUE lines into process.env without overriding anything already set.
 */
function loadEnv(): void {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const SESSION_DIR = path.join(__dirname, "..", "session");
const SESSION_FILE = path.join(SESSION_DIR, "session.txt");

type ParserName = "sureshot" | "fxoro";

interface ChannelConfig {
  username: string;
  parser: ParserName;
}

interface Config {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  webhookUrl: string;
  channels: ChannelConfig[];
}

// Per-channel runtime state. SureShot is stateful (it buffers a multi-message
// signal) so each such channel gets its own parser instance; fxoro is stateless.
// Each channel has its own dedupe set because message ids are only unique within
// a channel.
interface ChannelRuntime {
  cfg: ChannelConfig;
  entity: Api.TypeEntityLike;
  peerId: string;
  title: string;
  sureshot: SignalParser | null;
  seen: Set<number>;
}

function loadConfig(): Config {
  const apiId = parseInt(process.env.API_ID || "", 10);
  const apiHash = process.env.API_HASH || "";
  const phoneNumber = process.env.PHONE_NUMBER || "";
  const webhookUrl = process.env.WEBHOOK_URL || "http://localhost:9009/webhook";

  // Read CHANNEL_1..CHANNEL_5 (USERNAME + PARSER) pairs.
  const channels: ChannelConfig[] = [];
  for (let i = 1; i <= 5; i++) {
    const username = (process.env[`CHANNEL_${i}_USERNAME`] || "").trim();
    if (!username) continue;
    const raw = (process.env[`CHANNEL_${i}_PARSER`] || "sureshot").trim().toLowerCase();
    if (raw !== "sureshot" && raw !== "fxoro") {
      console.warn(`[config] CHANNEL_${i}_PARSER="${raw}" not recognized; defaulting to sureshot`);
    }
    channels.push({ username, parser: raw === "fxoro" ? "fxoro" : "sureshot" });
  }
  // Backward compatibility with the original single-channel variable.
  if (channels.length === 0 && process.env.CHANNEL_USERNAME) {
    channels.push({ username: process.env.CHANNEL_USERNAME.trim(), parser: "sureshot" });
  }

  const missing: string[] = [];
  if (!apiId) missing.push("API_ID");
  if (!apiHash) missing.push("API_HASH");
  if (!phoneNumber) missing.push("PHONE_NUMBER");
  if (channels.length === 0) missing.push("CHANNEL_1_USERNAME");
  if (missing.length) {
    throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  }

  return { apiId, apiHash, phoneNumber, webhookUrl, channels };
}

function loadSession(): StringSession {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const saved = fs.readFileSync(SESSION_FILE, "utf8").trim();
      if (saved) {
        console.log("[session] Loaded saved session");
        return new StringSession(saved);
      }
    }
  } catch (err) {
    console.warn("[session] Could not read saved session, starting fresh:", err);
  }
  return new StringSession("");
}

function saveSession(session: StringSession): void {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, session.save(), "utf8");
    console.log("[session] Session saved");
  } catch (err) {
    console.error("[session] Failed to save session:", err);
  }
}

/** Prompt the user on the terminal (used for the login verification code). */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

/**
 * Resolve the configured channel into an entity, accepting either form:
 *   - public username:  "sureshotgold", "@sureshotgold", "t.me/sureshotgold"
 *   - private invite:   "https://t.me/+2bCJ...", "t.me/+2bCJ...", "+2bCJ..."
 *
 * Private channels (created from an invite link) have no username, so getEntity
 * can't find them. We resolve those via the invite hash with CheckChatInvite,
 * which returns the chat directly because the account is already a member.
 */
async function resolveChannel(client: TelegramClient, raw: string): Promise<Api.TypeEntityLike> {
  // Strip any t.me/ URL wrapper so we're left with "username", "+hash" or "joinchat/hash".
  let id = raw.trim().replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "");

  const inviteHash =
    id.startsWith("+") ? id.slice(1)
    : /^joinchat\//i.test(id) ? id.replace(/^joinchat\//i, "")
    : null;

  if (inviteHash) {
    const res = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
    // Already a member → the chat is included directly.
    if (res instanceof Api.ChatInviteAlready || res instanceof Api.ChatInvitePeek) {
      return res.chat;
    }
    throw new Error(
      `The account is not a member of the private channel for invite +${inviteHash}. ` +
      `Join it in Telegram first, then restart.`
    );
  }

  // Public username (drop a leading @).
  return client.getEntity(id.replace(/^@/, ""));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const session = loadSession();

  // gramJS handles low-level reconnects itself; the outer backoff loop below
  // covers the case where the connection is lost entirely.
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    retryDelay: 2000,
  });

  console.log("[telegram] Connecting...");

  // On first run this prompts for the login code (sent to the Telegram account)
  // and, if set, a 2FA password. On later runs the saved session skips all of it.
  await client.start({
    phoneNumber: async () => config.phoneNumber,
    phoneCode: async () => prompt("Enter the Telegram code you received: "),
    password: async () => prompt("Enter your 2FA password (leave blank if none): "),
    onError: (err) => console.error("[telegram] Auth error:", err),
  });

  saveSession(session);
  console.log("[telegram] Connected and authenticated");

  // Resolve every configured channel. Each keeps its entity (for direct polling)
  // and its marked peer id (to route incoming push updates). A channel that fails
  // to resolve is skipped rather than fatal, unless none resolve. We match
  // messages manually rather than via NewMessage({ chats }), which gramJS
  // resolves lazily and mishandles.
  const runtimes: ChannelRuntime[] = [];
  for (const cfg of config.channels) {
    try {
      const entity = await resolveChannel(client, cfg.username);
      const peerId = utils.getPeerId(entity);
      const title = (entity as { title?: string }).title || cfg.username;
      runtimes.push({
        cfg,
        entity,
        peerId,
        title,
        sureshot: cfg.parser === "sureshot" ? new SignalParser() : null,
        seen: new Set<number>(),
      });
      console.log(`[telegram] Listening to ${title} (peer ${peerId}, parser ${cfg.parser})`);
    } catch (err) {
      console.error(`[telegram] Could not resolve channel "${cfg.username}" (parser ${cfg.parser}): ${err instanceof Error ? err.message : err}`);
    }
  }
  if (runtimes.length === 0) {
    throw new Error("No channels could be resolved; nothing to listen to");
  }
  const byPeer = new Map<string, ChannelRuntime>();
  for (const rt of runtimes) byPeer.set(rt.peerId, rt);

  // Route a message to its channel's parser and forward any complete signal.
  // Messages reach us two ways (push updates, instant but can silently desync;
  // and polling, slower but reliable). Both feed this handler, deduped per
  // channel by message id so nothing is processed twice.
  const handleMessage = async (rt: ChannelRuntime, id: number, text: string, source: string): Promise<void> => {
    if (id && rt.seen.has(id)) return;
    if (id) rt.seen.add(id);
    console.log(`[channel:${rt.cfg.parser}] Message (${source}, id ${id}): ${JSON.stringify(text)}`);
    const signal = rt.sureshot ? rt.sureshot.processMessage(text) : parseFxoroSignal(text);
    if (signal) {
      console.log("[signal] Complete signal extracted:", signal);
      await sendSignal(signal, config.webhookUrl, rt.title);
    }
  };

  // Push path: one catch-all handler routes each message to its channel by id.
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const chatId = event.message?.chatId?.toString();
      if (!chatId) return;
      const rt = byPeer.get(chatId);
      if (!rt) return; // not one of our channels
      await handleMessage(rt, event.message!.id, event.message!.message ?? "", "push");
    } catch (err) {
      // A single bad message must never take the process down.
      console.error("[message] Error handling push message (skipped):", err);
    }
  }, new NewMessage({}));

  // Poll path: the reliable safety net, per channel. Seed each with its current
  // latest ids so we do not replay history, then every 15s fetch recent messages
  // for each channel and process any new ones. Catches signals the push stream
  // misses when a channel's update sequence desyncs.
  for (const rt of runtimes) {
    try {
      const seed = await client.getMessages(rt.entity, { limit: 25 });
      for (const m of seed) rt.seen.add(m.id);
      console.log(`[poll] Seeded ${seed.length} id(s) for the ${rt.cfg.parser} channel`);
    } catch (err) {
      console.warn(`[poll] Seed failed for the ${rt.cfg.parser} channel: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("[poll] Polling every 15s");

  setInterval(async () => {
    for (const rt of runtimes) {
      try {
        const msgs = await client.getMessages(rt.entity, { limit: 25 });
        const fresh = msgs.filter((m) => !rt.seen.has(m.id)).sort((a, b) => a.id - b.id);
        for (const m of fresh) {
          console.log(`[poll] ${rt.cfg.parser} channel: found a message the push stream missed (id ${m.id})`);
          await handleMessage(rt, m.id, m.message ?? "", "poll");
        }
        // Bound the dedupe set: keep only the most recent ids.
        if (rt.seen.size > 1000) {
          const top = [...rt.seen].sort((a, b) => b - a).slice(0, 500);
          rt.seen.clear();
          for (const id of top) rt.seen.add(id);
        }
      } catch (err) {
        console.warn(`[poll] Fetch failed for the ${rt.cfg.parser} channel: ${err instanceof Error ? err.message : err}`);
      }
    }
  }, 15_000);

  // VALIDATION INSTRUMENTATION (diagnosing missed signals after a gramJS
  // reconnect). Count EVERY raw update the client receives, regardless of chat.
  // The hypothesis is that after a socket reconnect the update stream stops
  // delivering updates to our handlers while the request channel (GetState)
  // keeps answering. If so, after a reconnect we should see GetState succeed and
  // its pts advance while this raw-update count stays at 0.
  let rawUpdatesSinceTick = 0;
  let lastUpdateAt = Date.now();
  client.addEventHandler(() => {
    rawUpdatesSinceTick++;
    lastUpdateAt = Date.now();
  }, new Raw({}));

  // Liveness watchdog. The MTProto update stream can go silent while the Node
  // process stays alive and `client.connected` still reports true, so pm2 sees
  // us as "online" and never restarts and messages are silently missed. A passive
  // `client.connected` check does not catch that, so actively round-trip to
  // Telegram on an interval; on repeated failure force a reconnect, and if that
  // fails exit so pm2 restarts us cleanly with the saved session.
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);

  let watchdogFails = 0;
  setInterval(async () => {
    try {
      const st: any = await withTimeout(client.invoke(new Api.updates.GetState()), 15_000);
      // Validation line: pairs the server update counter (pts) with how many
      // updates we actually received. pts climbing while updates stay 0 over
      // several ticks is the dead-update-stream signature.
      const sinceUpdate = Math.round((Date.now() - lastUpdateAt) / 1000);
      console.log(`[telegram] Liveness OK: GetState pts=${st?.pts} qts=${st?.qts}, raw updates last 60s=${rawUpdatesSinceTick}, last update ${sinceUpdate}s ago`);
      rawUpdatesSinceTick = 0;
      if (watchdogFails > 0) console.log("[telegram] Liveness recovered");
      watchdogFails = 0;
    } catch (err) {
      watchdogFails++;
      console.warn(`[telegram] Liveness check failed (${watchdogFails}/3): ${err instanceof Error ? err.message : err}`);
      if (watchdogFails < 3) return;
      try {
        await client.connect();
        await withTimeout(client.invoke(new Api.updates.GetState()), 15_000);
        console.log("[telegram] Reconnected, updates flowing again");
        watchdogFails = 0;
      } catch (reErr) {
        console.error(`[telegram] Connection dead, reconnect failed, exiting for pm2 restart: ${reErr instanceof Error ? reErr.message : reErr}`);
        process.exit(1);
      }
    }
  }, 60_000);

  console.log("[telegram] Listener is running");
}

// Crash on nothing: log unexpected errors and keep going.
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection (kept alive):", reason);
});

main().catch((err) => {
  // Startup failed (bad config / auth / channel). Log clearly and exit so a
  // process manager can restart us; runtime errors are handled above.
  console.error("[fatal] Startup failed:", err);
  process.exit(1);
});
