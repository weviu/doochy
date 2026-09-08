import { state, primaryRuntimes } from "../../state";
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
  const accounts = primaryRuntimes().filter((rt) => rt.accountInfo);
  let line: string;
  if (accounts.length === 0) {
    line = "No balance data yet (broker not connected).";
  } else {
    const total = accounts.reduce((s, rt) => s + rt.accountInfo.balance, 0);
    const currency = accounts[0].accountInfo.currency;
    line = accounts.length > 1
      ? `Current balance: $${total.toFixed(2)} ${currency}\n${accounts.map((rt) => `  ${rt.ctid}: $${rt.accountInfo.balance.toFixed(2)} ${rt.accountInfo.currency}`).join("\n")}`
      : `Current balance: $${total.toFixed(2)} ${currency}`;
  }
  const lines = [
    line,
    initial > 0
      ? `Account size (chart line): $${initial.toFixed(2)}`
      : "Account size not set — run /balance init <USD> to see the chart reference line.",
  ];
  await ctx.reply(lines.join("\n"));
}
