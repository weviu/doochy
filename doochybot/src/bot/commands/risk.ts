import { state, persistSettings } from "../../state";

export async function riskCmd(ctx: any) {
  const msg = ctx.message.text.trim();
  const parts = msg.split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply("Usage: /risk pertrade <usd> | /risk maxpos <n> | /risk maxloss <usd> | /risk cap <usd> (SL/TP come from the signal)");
    return;
  }

  const setting = parts[1]?.toLowerCase();

  if (setting === "maxpos" && parts[2]) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 1 || n > 20) {
      await ctx.reply("Max positions must be between 1 and 20.");
      return;
    }
    state.settings.maxPositions = n;
    persistSettings();
    await ctx.reply(`Max positions set to ${n}.`);
    return;
  }

  if (setting === "maxloss" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 1) {
      await ctx.reply("Max daily loss USD must be at least 1.");
      return;
    }
    state.settings.maxDailyLossUSD = usd;
    persistSettings();
    await ctx.reply(`Max daily loss set to $${usd}.`);
    return;
  }

  if (setting === "cap" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Profit cap USD must be 0 (disabled) or greater.");
      return;
    }
    state.settings.dailyProfitCapUSD = usd;
    persistSettings();
    await ctx.reply(
      usd === 0
        ? "Daily profit cap disabled."
        : `Daily profit cap set to $${usd}. Once realized + floating P&L reaches it, ALL positions are force-closed and new signals stop for the day. Buffer: $${(state.settings.capBufferUSD ?? 0).toFixed(2)} below cap.`
    );
    return;
  }

  if (setting === "capbuffer" && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Cap buffer USD must be 0 or greater.");
      return;
    }
    state.settings.capBufferUSD = usd;
    persistSettings();
    await ctx.reply(
      usd === 0
        ? "Cap buffer cleared — positions close exactly at the cap."
        : `Cap buffer set to $${usd}. Positions force-close once profit reaches cap − $${usd}, so the cap is never overshot.`
    );
    return;
  }

  if (setting === "losses" && parts[2]) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 20) {
      await ctx.reply("Consecutive losses must be 0 (disabled) to 20.");
      return;
    }
    state.settings.maxConsecutiveLosses = n;
    persistSettings();
    await ctx.reply(
      n === 0
        ? "Consecutive-loss protection disabled."
        : `Consecutive-loss protection: ${n} SL hits within ${state.settings.lossWindowMinutes}m → ${state.settings.cooldownMinutes}m cooldown.`
    );
    return;
  }

  if (setting === "losswindow" && parts[2]) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 1 || min > 1440) {
      await ctx.reply("Loss window must be between 1 and 1440 minutes.");
      return;
    }
    state.settings.lossWindowMinutes = min;
    persistSettings();
    await ctx.reply(`Loss-counting window set to ${min} minutes.`);
    return;
  }

  if (setting === "cooldown" && parts[2]) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 1 || min > 1440) {
      await ctx.reply("Cooldown must be between 1 and 1440 minutes.");
      return;
    }
    state.settings.cooldownMinutes = min;
    persistSettings();
    await ctx.reply(`Per-symbol cooldown set to ${min} minutes.`);
    return;
  }

  if (setting === "reentry" && parts[2] !== undefined) {
    const min = parseInt(parts[2]);
    if (isNaN(min) || min < 0 || min > 1440) {
      await ctx.reply("Re-entry cooldown must be between 0 and 1440 minutes (0 = off).");
      return;
    }
    state.settings.reentryCooldownMinutes = min;
    persistSettings();
    await ctx.reply(
      min === 0
        ? "Re-entry cooldown disabled."
        : `Re-entry cooldown set to ${min} minutes (blocks reopening the same symbol+direction after a loss).`
    );
    return;
  }

  if (setting === "combined" && parts[2] !== undefined) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0 || usd > 100000) {
      await ctx.reply("Combined risk limit must be between 0 and 100000 USD (0 = off).");
      return;
    }
    state.settings.maxCombinedRiskUSD = usd;
    persistSettings();
    await ctx.reply(
      usd === 0
        ? "Combined risk limit disabled."
        : `Combined risk limit set to $${usd} (max summed risk across all positions of the same symbol+direction).`
    );
    return;
  }

  if (setting === "confidence" && parts[2] !== undefined) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 100) {
      await ctx.reply("Channel confidence must be between 0 and 100 (default 69).");
      return;
    }
    state.settings.webhookConfidence = n;
    persistSettings();
    await ctx.reply(`Channel signal confidence set to ${n}. Channel signals can now flip an open position with lower confidence; feed signals need a higher score to flip a channel position.`);
    return;
  }

  if (setting === "minconfidence" && parts[2] !== undefined) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 100) {
      await ctx.reply("Minimum confidence must be between 0 and 100% (0 = off).");
      return;
    }
    state.settings.minConfidence = n;
    persistSettings();
    await ctx.reply(
      n === 0
        ? "Minimum confidence gate disabled. All feed signals may open positions."
        : `Minimum confidence set to ${n}. Feed signals scoring below ${n} are rejected; channel signals bypass this.`
    );
    return;
  }

  if (setting === "stalebars" && parts[2] !== undefined) {
    const n = parseInt(parts[2]);
    if (isNaN(n) || n < 0 || n > 100) {
      await ctx.reply("Stale-order bars must be 0 (never expire) to 100.");
      return;
    }
    state.settings.staleOrderBars = n;
    persistSettings();
    await ctx.reply(
      n === 0
        ? "Stale-order guard off. Feed stop/limit orders rest good-till-cancel until filled or manually cancelled."
        : `Stale-order guard set to ${n} bars. A feed stop/limit that hasn't filled within ${n} bars of the signal's timeframe (e.g. ${n} x 30m = ${n * 30}m) is expired by the broker.`
    );
    return;
  }

  if (setting === "marginaware" && parts[2] !== undefined) {
    const arg = parts[2].toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /risk marginaware on | off");
      return;
    }
    state.settings.marginAware = arg === "on";
    persistSettings();
    await ctx.reply(
      state.settings.marginAware
        ? "Margin-aware sizing on. Each order is capped to fit the account's free margin."
        : "Margin-aware sizing off. Orders use the full risk-based size; manage margin via /risk pertrade and /risk maxpos."
    );
    return;
  }


  // BTC macro-bias gate for crypto BUYs:
  //   /risk btcbias on|off                  - master switch
  //   /risk btcbias bearish <n>             - confidence floor during BTC BEARISH
  //   /risk btcbias strongbearish <n>       - confidence floor during BTC BEARISH_STRONG
  if (setting === "btcbias") {
    const sub = parts[2]?.toLowerCase();

    if (sub === "on" || sub === "off") {
      state.settings.btcBiasGate = sub === "on";
      persistSettings();
      await ctx.reply(
        state.settings.btcBiasGate
          ? `BTC-bias gate on. Crypto BUYs need confidence >= ${state.settings.btcBiasMinConfStrongBearish} when BTC is BEARISH_STRONG and >= ${state.settings.btcBiasMinConfBearish} when BEARISH; SELLs and non-crypto are unaffected.`
          : "BTC-bias gate off. Crypto BUYs are no longer suppressed during BTC bearishness."
      );
      return;
    }

    if ((sub === "bearish" || sub === "strongbearish") && parts[3] !== undefined) {
      const n = parseInt(parts[3]);
      if (isNaN(n) || n < 0 || n > 100) {
        await ctx.reply("Confidence floor must be between 0 and 100.");
        return;
      }
      if (sub === "bearish") state.settings.btcBiasMinConfBearish = n;
      else state.settings.btcBiasMinConfStrongBearish = n;
      persistSettings();
      const stateName = sub === "bearish" ? "BEARISH" : "BEARISH_STRONG";
      await ctx.reply(`Crypto BUYs now need confidence >= ${n} when BTC is ${stateName}.`);
      return;
    }

    await ctx.reply(
      `BTC-bias gate is ${state.settings.btcBiasGate ? "on" : "off"} (BEARISH floor ${state.settings.btcBiasMinConfBearish}, BEARISH_STRONG floor ${state.settings.btcBiasMinConfStrongBearish}).\n` +
      "Usage: /risk btcbias on | off | bearish <0-100> | strongbearish <0-100>"
    );
    return;
  }

  // "pertrade" is the documented name; "risk" kept as a silent alias so older
  // muscle memory still works.
  if ((setting === "pertrade" || setting === "risk") && parts[2]) {
    const usd = parseFloat(parts[2]);
    if (isNaN(usd) || usd < 0) {
      await ctx.reply("Per-trade risk USD must be 0 (disabled) or greater.");
      return;
    }
    state.settings.riskPerTradeUSD = usd;
    persistSettings();
    await ctx.reply(
      usd === 0
        ? "Per-trade risk sizing disabled — trading off (there is no fixed-lot fallback)."
        : `Per-trade risk set to $${usd}. Each position is sized so the distance from entry to the signal's own stop loss loses ~$${usd}. SL/TP come from the signal itself; a signal with no SL/TP is skipped.`
    );
    return;
  }

  if (setting === "overrun" && parts[2] !== undefined) {
    const pct = parseFloat(parts[2]);
    if (isNaN(pct) || pct < 0 || pct > 100000) {
      await ctx.reply("Risk overrun % must be 0 (strict) or greater.");
      return;
    }
    state.settings.riskOverrunPercent = pct;
    persistSettings();
    await ctx.reply(
      pct === 0
        ? "Risk overrun set to 0 (strict): a trade is skipped whenever the smallest tradable lot would risk more than /risk pertrade."
        : `Risk overrun set to ${pct}%. A trade is allowed through when the broker's minimum lot forces its risk up to ${pct}% over your per-trade target (e.g. $${state.settings.riskPerTradeUSD} -> up to $${(state.settings.riskPerTradeUSD * (1 + pct / 100)).toFixed(2)}); beyond that it is skipped. Set a large value to effectively disable the guard.`
    );
    return;
  }

  await ctx.reply("Unknown setting. Usage: /risk pertrade <usd> | /risk overrun <pct> | /risk maxpos <n> | /risk maxloss <usd> | /risk cap <usd> | /risk capbuffer <usd> | /risk losses <n> | /risk losswindow <min> | /risk cooldown <min> | /risk reentry <min> | /risk combined <usd> | /risk confidence <n> | /risk minconfidence <n>% | /risk stalebars <n> | /risk marginaware on|off | /risk btcbias on|off|bearish <n>|strongbearish <n>");
}