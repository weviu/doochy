import { state, persistSettings } from "../../state";

export async function minholdCmd(ctx: any) {
  const msg = ctx.message.text.trim();
  const parts = msg.split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply(`Min hold is ${state.settings.minHoldSeconds}s (delay before TP is set). Usage: /minhold <seconds>`);
    return;
  }

  const secs = parseInt(parts[1]);
  if (isNaN(secs) || secs < 0 || secs > 3600) {
    await ctx.reply("Min hold must be between 0 and 3600 seconds.");
    return;
  }

  state.settings.minHoldSeconds = secs;
  persistSettings();
  await ctx.reply(`Min hold set to ${secs}s (delay before TP is set).`);
}
