import { state, settingsFor, persistAccountSettings, persistGlobalSettings } from "../../state";
import { commandAccount, accountListText } from "./account";
import { accountLabel } from "../../ctrader/brokerDirectory";

export async function riskCmd(ctx: any) {
  const msg = ctx.message.text.trim();
  const acc = commandAccount(ctx, msg.split(/\s+/));
  const parts = acc.parts;

  if (parts.length < 2) {
    await ctx.reply("Usage: /risk pertrade <usd> | /risk maxpos <n> | /risk maxloss <usd> | /risk cap <usd> (SL/TP come from the signal)");
    return;
  }

  const setting = parts[1]?.toLowerCase();

  // GLOBAL setting: channel/webhook confidence applies to the whole process
  // (it decides how channel signals that carry no confidence of their own are
  // scored), not to one account, so it is resolved before any account targets
  // and a trailing account arg is simply ignored.
  if (setting === "confidence" && parts[2] !== undefined) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 100) {
      await ctx.reply("Channel confidence must be between 0 and 100 (default 69).");
      return;
    }
    state.settings.webhookConfidence = n;
    persistGlobalSettings();
    await ctx.reply(`Channel signal confidence set to ${n}. Channel signals can now flip an open position with lower confidence; feed signals need a higher score to flip a channel position.`);
    return;
  }

  // Everything else in /risk mutates ONE account's per-account settings, so it
  // needs a target account.
  if (acc.ctid === undefined) {
    await ctx.reply(`Which account? Append a login or ctid: /risk ${setting} ${parts[2] ?? ""} <login>. Accounts: ${accountListText()}`);
    return;
  }
  const ctid = acc.ctid;
  const s = settingsFor(ctid);
  const persist = () => persistAccountSettings(ctid);
  const tag = acc.multi ? ` (${accountLabel(ctid) ?? ctid})` : "";

  if (setting === "maxpos" && parts[2]) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 1 || n > 20) {
      await ctx.reply("Max positions must be between 1 and 20.");
      return;
    }
    s.maxPositions = n;
    persist();
    await ctx.reply(`Max positions set to ${n}.${tag}`);
    return;
  }

  if (setting === "maxloss" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 1) {
      await ctx.reply("Max daily loss USD must be at least 1.");
      return;
    }
    s.maxDailyLossUSD = usd;
    persist();
    await ctx.reply(`Max daily loss set to $${usd}.${tag}`);
    return;
  }

  if (setting === "cap" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Profit cap USD must be 0 (disabled) or greater.");
      return;
    }
    s.dailyProfitCapUSD = usd;
    persist();
    await ctx.reply(
      usd === 0
        ? `Daily profit cap disabled.${tag}`
        : `Daily profit cap set to $${usd}. Once realized + floating P&L reaches it, ALL positions are force-closed and new signals stop for the day. Buffer: $${(s.capBufferUSD ?? 0).toFixed(2)} below cap.${tag}`
    );
    return;
  }

  if (setting === "capbuffer" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Cap buffer USD must be 0 or greater.");
      return;
    }
    s.capBufferUSD = usd;
    persist();
    await ctx.reply(
      usd === 0
        ? `Cap buffer cleared — positions close exactly at the cap.${tag}`
        : `Cap buffer set to $${usd}. Positions force-close once profit reaches cap − $${usd}, so the cap is never overshot.${tag}`
    );
    return;
  }

  if (setting === "losses" && parts[2]) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 20) {
      await ctx.reply("Consecutive losses must be 0 (disabled) to 20.");
      return;
    }
    s.maxConsecutiveLosses = n;
    persist();
    await ctx.reply(
      n === 0
        ? `Consecutive-loss protection disabled.${tag}`
        : `Consecutive-loss protection: ${n} SL hits within ${s.lossWindowMinutes}m → ${s.cooldownMinutes}m cooldown.${tag}`
    );
    return;
  }

  if (setting === "losswindow" && parts[2]) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 1 || min > 1440) {
      await ctx.reply("Loss window must be between 1 and 1440 minutes.");
      return;
    }
    s.lossWindowMinutes = min;
    persist();
    await ctx.reply(`Loss-counting window set to ${min} minutes.${tag}`);
    return;
  }

  if (setting === "cooldown" && parts[2]) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 1 || min > 1440) {
      await ctx.reply("Cooldown must be between 1 and 1440 minutes.");
      return;
    }
    s.cooldownMinutes = min;
    persist();
    await ctx.reply(`Per-symbol cooldown set to ${min} minutes.${tag}`);
    return;
  }

  if (setting === "reentry" && parts[2] !== undefined) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 0 || min > 1440) {
      await ctx.reply("Re-entry cooldown must be between 0 and 1440 minutes (0 = off).");
      return;
    }
    s.reentryCooldownMinutes = min;
    persist();
    await ctx.reply(
      min === 0
        ? `Re-entry cooldown disabled.${tag}`
        : `Re-entry cooldown set to ${min} minutes (blocks reopening the same symbol+direction after a loss).${tag}`
    );
    return;
  }

  if (setting === "combined" && parts[2] !== undefined) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0 || usd > 100000) {
      await ctx.reply("Combined risk limit must be between 0 and 100000 USD (0 = off).");
      return;
    }
    s.maxCombinedRiskUSD = usd;
    persist();
    await ctx.reply(
      usd === 0
        ? `Combined risk limit disabled.${tag}`
        : `Combined risk limit set to $${usd} (max summed risk across all positions of the same symbol+direction).${tag}`
    );
    return;
  }

  if (setting === "minconfidence" && parts[2] !== undefined) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 100) {
      await ctx.reply("Minimum confidence must be between 0 and 100% (0 = off).");
      return;
    }
    s.minConfidence = n;
    persist();
    await ctx.reply(
      n === 0
        ? `Minimum confidence gate disabled. All feed signals may open positions.${tag}`
        : `Minimum confidence set to ${n}. Feed signals scoring below ${n} are rejected; channel signals bypass this.${tag}`
    );
    return;
  }

  if (setting === "marginaware" && parts[2] !== undefined) {
    const arg = parts[2].toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /risk marginaware on | off");
      return;
    }
    s.marginAware = arg === "on";
    persist();
    await ctx.reply(
      s.marginAware
        ? `Margin-aware sizing on. Each order is capped to fit the account's free margin.${tag}`
        : `Margin-aware sizing off. Orders use the full risk-based size; manage margin via /risk pertrade and /risk maxpos.${tag}`
    );
    return;
  }

  if (setting === "midnightflatten" && parts[2] !== undefined) {
    const arg = parts[2].toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /risk midnightflatten on | off");
      return;
    }
    s.midnightFlatten = arg === "on";
    persist();
    await ctx.reply(
      s.midnightFlatten
        ? `Midnight flatten on. All positions and resting orders are closed in the final minutes before the broker's daily reset.${tag}`
        : `Midnight flatten off. Positions ride through the broker's midnight untouched. Make sure this is allowed by your prop firm's overnight rules.${tag}`
    );
    return;
  }

  // "pertrade" is the documented name; "risk" kept as a silent alias so older
  // muscle memory still works.
  if ((setting === "pertrade" || setting === "risk") && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Per trade risk USD must be 0 (disabled) or greater.");
      return;
    }
    s.riskPerTradeUSD = usd;
    persist();
    await ctx.reply(
      usd === 0
        ? `Per trade risk sizing disabled - trading off (there is no fixed lot fallback).${tag}`
        : `Per trade risk set to $${usd}. Each position is sized so the distance from entry to the signal's stop loss loses ~$${usd}.
        ${tag}`    );
    return;
  }

  if (setting === "overrun" && parts[2] !== undefined) {
    const pct = parseFloat(parts[2]);
    if (isNaN(pct) || pct < 0 || pct > 100000) {
      await ctx.reply("Risk overrun % must be 0 (strict) or greater.");
      return;
    }
    s.riskOverrunPercent = pct;
    persist();
    await ctx.reply(
      pct === 0
        ? `Risk overrun set to 0 (strict): a trade is skipped whenever the smallest tradable lot would risk more than /risk pertrade.${tag}`
        : `Risk overrun set to ${pct}%. A trade is allowed through when the broker's minimum lot forces its risk up to ${pct}% over your per-trade target (e.g. $${s.riskPerTradeUSD} -> up to $${(s.riskPerTradeUSD * (1 + pct / 100)).toFixed(2)}); beyond that it is skipped. Set a large value to effectively disable the guard.${tag}`
    );
    return;
  }

  await ctx.reply("Unknown setting. Usage: /risk pertrade <usd> | /risk overrun <pct> | /risk maxpos <n> | /risk maxloss <usd> | /risk cap <usd> | /risk capbuffer <usd> | /risk losses <n> | /risk losswindow <min> | /risk cooldown <min> | /risk reentry <min> | /risk combined <usd> | /risk confidence <n> | /risk minconfidence <n>% | /risk marginaware on|off | /risk midnightflatten on|off");
}