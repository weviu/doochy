import { state } from "../../state";
import { closeAllPositions } from "../../risk/midnightClose";

export async function closeallCmd(ctx: any) {
  const count = state.positions.size;
  if (count === 0) {
    await ctx.reply("No open positions to close.");
    return;
  }

  await ctx.reply(`Closing ${count} positions...`);
  const { closed, failed } = await closeAllPositions();
  await ctx.reply(`Closed ${closed} positions. Failed: ${failed}`);
}
