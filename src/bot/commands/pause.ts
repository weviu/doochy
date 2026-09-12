import { primaryByKey } from "../../ctrader/accounts";
import { accountLabel } from "../../ctrader/brokerDirectory";
import { pauseTrading } from "../../miniapp/service";

export async function pauseCmd(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const key = parts[1];

  // With an account argument, pause only that account (independent of the
  // others). Without one, pause everything (the legacy global behavior).
  if (key) {
    const acc = primaryByKey(key);
    if (!acc) {
      await ctx.reply(`Unknown account "${key}". Use /status to see your accounts (by login).`);
      return;
    }
    pauseTrading(acc.ctid);
    const label = `${accountLabel(acc.ctid) ?? acc.login} paused. Use /resume ${acc.login} to enable.`;
    await ctx.reply(label);
    return;
  }

  pauseTrading();
  await ctx.reply("Trading paused on all accounts. Use /resume to enable.");
}