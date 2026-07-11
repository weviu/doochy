import { state, setTradingLock } from "../../state";

export async function resumeCmd(ctx: any) {
  // Resume also clears a daily loss/profit-cap lock - the manual reset before
  // the automatic midnight UTC reset.
  const wasLocked = state.tradingLocked;
  state.paused = false;
  setTradingLock(false);
  await ctx.reply(wasLocked ? "Trading resumed. Daily limit lock cleared." : "Trading resumed.");
}
