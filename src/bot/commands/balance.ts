import { primaryRuntimes, settingsFor, persistAccountSettings } from "../../state";
import { commandAccount, accountListText } from "./account";
import { accountLabel } from "../../ctrader/brokerDirectory";

// Set the fixed "Account size" reference line used by the balance chart, per
// traded account. This is normally the prop-firm starting capital (e.g. 10000).
export async function balanceCmd(ctx: any) {
  const text = ctx.message?.text || "";
  const acc = commandAccount(ctx, text.trim().split(/\s+/));
  const parts = acc.parts;
  const sub = parts[1]?.toLowerCase();

  if (sub === "init" || sub === "set") {
    const raw = parts[2];
    const value = raw ? Number(raw.replace(/[^0-9.]/g, "")) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      await ctx.reply("Usage: /balance init <USD> [<login>]\nExample: /balance init 10000");
      return;
    }
    if (acc.ctid === undefined) {
      await ctx.reply(`Which account? Append a login or ctid: /balance init <USD> <login>. Accounts: ${accountListText()}`);
      return;
    }
    const s = settingsFor(acc.ctid);
    s.initialBalanceUSD = value;
    persistAccountSettings(acc.ctid);
    const tag = acc.multi ? ` (${accountLabel(acc.ctid) ?? acc.ctid})` : "";
    await ctx.reply(`Starting account size set to $${value.toFixed(2)}${tag}. The balance chart will use this as the fixed "Account size" line.`);
    return;
  }

  const accounts = primaryRuntimes().filter((rt) => rt.accountInfo);
  const lines: string[] = [];
  if (accounts.length === 0) {
    lines.push("No balance data yet (broker not connected).");
  } else {
    const total = accounts.reduce((sum, rt) => sum + rt.accountInfo.balance, 0);
    const currency = accounts[0].accountInfo.currency;
    lines.push(`Current balance: $${total.toFixed(2)} ${currency}`);
    for (const rt of accounts) {
      const init = settingsFor(rt.ctid).initialBalanceUSD;
      const initPart = init > 0 ? ` · size $${init.toFixed(2)}` : "";
      lines.push(`  ${accountLabel(rt.ctid) ?? rt.ctid}: $${rt.accountInfo.balance.toFixed(2)} ${rt.accountInfo.currency}${initPart}`);
    }
  }
  // Single account: keep the compact "chart line" note as before; multi-account
  // sizes already appear on their per-account lines above.
  if (accounts.length === 1) {
    const initial = settingsFor(accounts[0].ctid).initialBalanceUSD;
    lines.push(initial > 0 ? `Account size (chart line): $${initial.toFixed(2)}` : "Account size not set — run /balance init <USD> to see the chart reference line.");
  }
  await ctx.reply(lines.join("\n"));
}