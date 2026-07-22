import { activeCooldowns, clearCooldown } from "../../risk/cooldown";

export async function cooldownCmd(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const action = parts[1]?.toLowerCase();

  // /cooldown reset [SYMBOL] — clear one symbol or all cooldowns.
  if (action === "reset") {
    const symbol = parts[2]?.toUpperCase();
    const cleared = clearCooldown(symbol);
    if (symbol) {
      await ctx.reply(cleared ? `Cooldown cleared for ${symbol}.` : `${symbol} is not cooled down.`);
    } else {
      await ctx.reply(cleared ? `Cleared ${cleared} active cooldown(s).` : "No active cooldowns.");
    }
    return;
  }

  // /cooldown — list active cooldowns.
  const active = activeCooldowns();
  if (active.length === 0) {
    await ctx.reply("No symbols are cooled down.");
    return;
  }
  const lines = active.map((c) => `${c.symbol} — ${Math.ceil(c.remainingMs / 60_000)}m left (${c.hits} SL hits)`);
  await ctx.reply("Cooled-down symbols:\n" + lines.join("\n") + "\n\nUse /cooldown reset [SYMBOL] to clear.");
}
