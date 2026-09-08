import { activeCooldowns, clearCooldown } from "../../risk/cooldown";
import { primaryRuntimes } from "../../state";

export async function cooldownCmd(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const action = parts[1]?.toLowerCase();

  // /cooldown reset [SYMBOL] — clear one symbol on all accounts, or all cooldowns.
  if (action === "reset") {
    const symbol = parts[2]?.toUpperCase();
    let cleared = 0;
    for (const rt of primaryRuntimes()) cleared += clearCooldown(rt, symbol);
    if (symbol) {
      await ctx.reply(cleared ? `Cooldown cleared for ${symbol}.` : `${symbol} is not cooled down.`);
    } else {
      await ctx.reply(cleared ? `Cleared ${cleared} active cooldown(s).` : "No active cooldowns.");
    }
    return;
  }

  // /cooldown — list active cooldowns (aggregated across accounts).
  const active = primaryRuntimes().flatMap((rt) =>
    activeCooldowns(rt).map((c) => ({ ...c, accountId: String(rt.ctid) }))
  );
  if (active.length === 0) {
    await ctx.reply("No symbols are cooled down.");
    return;
  }
  const lines = active.map((c) => `${c.accountId} ${c.symbol} — ${Math.ceil(c.remainingMs / 60_000)}m left (${c.hits} SL hits)`);
  await ctx.reply("Cooled-down symbols:\n" + lines.join("\n") + "\n\nUse /cooldown reset [SYMBOL] to clear.");
}