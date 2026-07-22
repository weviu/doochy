import { Bot, Context, InputFile } from "grammy";
import { Registry } from "./registry";
import { addUser, getUser, isKnownUser } from "./db";
import { persistSettingsSnapshot } from "./server";

// /export walks the broker's deal history in 7-day chunks, so a wide range can
// take far longer than a normal command's 15s. The agent is doing real work the
// whole time; time out generously rather than abandon a live request.
const EXPORT_TIMEOUT_MS = 120_000;

// The Hub's Telegram bot. It owns exactly three things itself: the whitelist,
// /pair, and static help text. Every trading command is relayed verbatim to
// the user's agent, owner and friends alike; there is no local trading path.

// Commands relayed to the agent. The Hub does not parse their arguments; the
// agent runs its existing handler and returns the text to display, so command
// semantics live in exactly one place.
const RELAYED_COMMANDS = [
  "status", "pause", "resume", "symbols", "risk", "minhold", "closeall",
  "export", "settings", "notifications", "cooldown", "positions", "guide",
] as const;

export function startHubBot(token: string, registry: Registry): Bot {
  const bot = new Bot(token);

  // Notifications (fills, safety alerts) arrive from agents over WS and are
  // routed here by the socket's authenticated user binding.
  registry.setNotifySink((userId, message) => {
    bot.api.sendMessage(userId, message).catch((err) =>
      console.warn(`[HUB] Could not notify user ${userId}: ${err.message}`)
    );
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isKnownUser(userId)) {
      if (userId) await ctx.reply("Unauthorized");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    // Give every user the "Open App" menu button next to the message box.
    // Set per chat because the bot-level default is unreliable to read back
    // and BotFather settings can override it; per-chat always wins.
    await ctx.api.setChatMenuButton({
      chat_id: ctx.chat.id,
      menu_button: {
        type: "web_app",
        text: "Open App",
        web_app: { url: "https://doochy.route07.com/app" },
      },
    }).catch((err) => console.warn(`[HUB] Could not set menu button: ${err.message}`));
    await ctx.reply(
      "DoochyBot Hub.\n" +
      "Link your local agent with /pair, then use the usual commands.\n" +
      "/help for the command list."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "HUB\n" +
      "/pair: get a code to link your local agent\n" +
      "/adduser <id> [name]: whitelist a friend (owner only)\n" +
      "\n" +
      "TRADING (relayed to your agent)\n" +
      "/status /positions /pause /resume /closeall\n" +
      "/risk /symbols /minhold /cooldown /settings /notifications /export /guide\n" +
      "Manual orders: BUY|SELL <symbol> <lots> <TP> <SL>\n" +
      "\n" +
      "All trading commands need your agent online. If it is offline you will be told."
    );
  });

  // Owner-only onboarding: /adduser <telegram id> [name]. The friend gets
  // their ID from @userinfobot and sends it to the owner; removal stays a
  // users.json edit (rare, and deliberately not one typo away).
  bot.command("adduser", async (ctx) => {
    if (getUser(ctx.from!.id)?.role !== "owner") {
      await ctx.reply("Owner only.");
      return;
    }
    const parts = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
    const id = Number(parts[0]);
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply("Usage: /adduser <telegram id> [name]\nThe friend can get their id from @userinfobot.");
      return;
    }
    const name = parts.slice(1).join(" ") || `Friend-${String(id).slice(-4)}`;
    if (!addUser(id, name)) {
      await ctx.reply(`User ${id} is already added.`);
      return;
    }
    await ctx.reply(`Added ${name} (${id}). They can now /pair with this bot.`);
  });

  bot.command("pair", async (ctx) => {
    const code = registry.issuePairCode(ctx.from!.id);
    await ctx.reply(
      `Pairing code: ${code}\n` +
      "Enter it in your agent within 5 minutes. The code is single-use; run /pair again if it expires."
    );
  });

  const relay = async (ctx: Context, cmd: string, args: string[]) => {
    const userId = ctx.from!.id;
    const socket = registry.socketFor(userId);
    if (!socket) {
      await ctx.reply("Your agent is offline. Start it on your machine, or /pair to link one first.");
      return;
    }
    try {
      // /export builds its file by pulling weeks of deals from the broker, which
      // can outrun the default relay timeout; give a command that returns a
      // document more room rather than failing a request that is still working.
      const reply = await registry.request(socket, { type: "cmd", cmd, args }, EXPORT_TIMEOUT_MS);
      if (reply.data?.settings) persistSettingsSnapshot(userId, reply.data.settings);

      const text = reply.data?.text || (reply.ok ? "" : `Agent error: ${reply.error || "unknown"}`);
      if (text) await ctx.reply(text);

      // A command may return a file (today only /export). Rebuild it from base64
      // and send it as a real Telegram document.
      const doc = reply.data?.document;
      if (doc?.data && doc?.filename) {
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(doc.data, "base64"), doc.filename),
          doc.caption ? { caption: doc.caption } : undefined
        );
      } else if (!text) {
        await ctx.reply("OK");
      }
    } catch {
      await ctx.reply("Agent offline or not responding.");
    }
  };

  for (const cmd of RELAYED_COMMANDS) {
    bot.command(cmd, (ctx) => {
      const argText = typeof ctx.match === "string" ? ctx.match.trim() : "";
      return relay(ctx, cmd, argText ? argText.split(/\s+/) : []);
    });
  }

  // Manual orders are typed without a slash ("SELL XAUUSD 0.02 3950 4010");
  // forward the whole line and let the agent's order parser deal with it.
  bot.hears(/^\s*(buy|sell)\b/i, (ctx) =>
    relay(ctx, "order", (ctx.message?.text || "").trim().split(/\s+/))
  );

  // start() rejects asynchronously on a bad/unreachable token. Catch it here so
  // a wrong HUB_BOT_TOKEN degrades to a warning instead of an unhandled
  // rejection killing the Hub: WS and the API must stay up regardless.
  bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`[HUB] Telegram bot started as @${me.username}`),
  }).catch((err) => {
    console.warn(`[HUB] Telegram bot failed to start: ${err.message}. WS and API stay up; fix HUB_BOT_TOKEN and restart.`);
  });

  return bot;
}
