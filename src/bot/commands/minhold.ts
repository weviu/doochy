import { settingsFor, persistAccountSettings } from "../../state";
import { commandAccount, accountListText } from "./account";
import { accountLabel } from "../../ctrader/brokerDirectory";

export async function minholdCmd(ctx: any) {
  const msg = ctx.message.text.trim();
  const acc = commandAccount(ctx, msg.split(/\s+/));
  const parts = acc.parts;

  if (parts.length < 2) {
    const s = settingsFor(acc.ctid);
    const tag = acc.multi && acc.ctid !== undefined ? ` (${accountLabel(acc.ctid) ?? acc.ctid})` : "";
    await ctx.reply(`Min hold is ${s.minHoldSeconds}s (delay before TP is set)${tag}. Usage: /minhold <seconds>`);
    return;
  }

  if (acc.ctid === undefined) {
    await ctx.reply(`Which account? Append a login or ctid: /minhold <seconds> <login>. Accounts: ${accountListText()}`);
    return;
  }

  const secs = parseInt(parts[1]);
  if (isNaN(secs) || secs < 0 || secs > 3600) {
    await ctx.reply("Min hold must be between 0 and 3600 seconds.");
    return;
  }

  const s = settingsFor(acc.ctid);
  s.minHoldSeconds = secs;
  persistAccountSettings(acc.ctid);
  const tag = acc.multi ? ` (${accountLabel(acc.ctid) ?? acc.ctid})` : "";
  await ctx.reply(`Min hold set to ${secs}s (delay before TP is set)${tag}.`);
}