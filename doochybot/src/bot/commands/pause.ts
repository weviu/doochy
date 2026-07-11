import { state } from "../../state";

export async function pauseCmd(ctx: any) {
  state.paused = true;
  await ctx.reply("Trading paused. Use /resume to enable.");
}