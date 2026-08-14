import { state } from "../../state";
import { saveSettings } from "../../storage";

// Set the fixed "Account size" reference line used by the balance chart.
// This is normally the prop-firm starting capital (e.g. 10000).
export async function balanceCmd(ctx: any) {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase();

  if (sub === "init" || sub === "set") {
    const raw = parts[2];
    const value = raw ? Number(raw.replace(/[^0-9.]/g, "")) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      await ctx.reply("Usage: /balance init <USD>\nExample: /balance init 10000");
      return;
    }
    state.settings.initialBalanceUSD = value;
    saveSettings(state.settings);
    await ctx.reply(`Starting account size set to $${value.toFixed(2)}. The balance chart will use this as the fixed "Account size" line.`);
    return;
  }

  const initial = state.settings.initialBalanceUSD;
  const lines = [
    `Current balance: $${state.accountInfo.balance.toFixed(2)} ${state.accountInfo.currency}`,
    initial > 0
      ? `Account size (chart line): $${initial.toFixed(2)}`
      : "Account size not set — run /balance init <USD> to see the chart reference line.",
  ];
  await ctx.reply(lines.join("\n"));
}
