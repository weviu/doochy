import { primaryRuntimes } from "../../state";
import { closeAllPositions } from "../../risk/midnightClose";

export async function closeallCmd(ctx: any) {
  const count = [...primaryRuntimes()].reduce((n, rt) => n + rt.positions.size, 0);
  if (count === 0) {
    await ctx.reply("No open positions to close.");
    return;
  }

  await ctx.reply(`Closing ${count} positions...`);
  let closed = 0;
  let failed = 0;
  for (const rt of primaryRuntimes()) {
    const res = await closeAllPositions(rt);
    closed += res.closed;
    failed += res.failed;
  }
  await ctx.reply(`Closed ${closed} positions. Failed: ${failed}`);
}
