import { resumeTrading } from "../../risk/engine";
import { primaryRuntimes } from "../../state";

export async function resumeCmd(ctx: any) {
  // Resume clears the pause; if a daily-limit lock was on, it also clears it
  // AND overrides the daily limits for the rest of the broker trading day —
  // otherwise the next signal would re-check the still-breached P&L and lock
  // right back (the old /resume silently did nothing after a realized breach).
  // Applies to every traded account.
  let wasLocked = false;
  for (const rt of primaryRuntimes()) {
    wasLocked = resumeTrading(rt).wasLocked || wasLocked;
  }
  await ctx.reply(
    wasLocked
      ? "Trading resumed. Daily-limit lock cleared — limits are OVERRIDDEN until the next broker trading day."
      : "Trading resumed."
  );
}