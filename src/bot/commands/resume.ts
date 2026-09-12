import { primaryByKey } from "../../ctrader/accounts";
import { accountLabel } from "../../ctrader/brokerDirectory";
import { resumeTrading } from "../../miniapp/service";

// Resume clears the pause; if a daily-limit lock was on, it also clears it AND
// overrides the daily limits for the rest of the broker trading day — otherwise
// the next signal would re-check the still-breached P&L and lock right back (the
// old /resume silently did nothing after a realized breach). With an account
// argument only that account is resumed; without one, every traded account.
export async function resumeCmd(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const key = parts[1];

  if (key) {
    const acc = primaryByKey(key);
    if (!acc) {
      await ctx.reply(`Unknown account "${key}". Use /status to see your accounts (by login).`);
      return;
    }
    const { wasLocked } = resumeTrading(acc.ctid);
    const label = accountLabel(acc.ctid) ?? String(acc.login);
    await ctx.reply(
      wasLocked
        ? `${label} resumed. Daily-limit lock cleared — limits are OVERRIDDEN until the next broker trading day.`
        : `${label} resumed.`
    );
    return;
  }

  const { wasLocked } = resumeTrading();
  await ctx.reply(
    wasLocked
      ? "Trading resumed. Daily-limit lock cleared — limits are OVERRIDDEN until the next broker trading day."
      : "Trading resumed."
  );
}