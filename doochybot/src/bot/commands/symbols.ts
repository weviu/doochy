import { state, persistSettings, DEFAULT_SETTINGS, symbolIdFor } from "../../state";
import { subscribeSpots, subscribeConversionPairs, canValueInUsd } from "../../ctrader/livePrices";

// A symbol is unsupported if the broker knows it (resolvable) but it can't be valued
// in USD: neither USD-quoted nor a non-USD pair with a conversion pair on the broker.
// The money model needs one of those to convert P&L/risk into dollars. Symbols the
// broker doesn't know are left alone here (the gate rejects them at trade time as
// "not available on broker"), so a typo isn't misreported as unsupported.
function isUnsupported(sym: string): boolean {
  return symbolIdFor(sym) !== undefined && !canValueInUsd(sym);
}

// Warm the spot and USD-conversion streams for freshly added symbols, so a JPY/CAD
// pair can be valued (and traded) without waiting for a bot restart to pre-subscribe.
async function warmStreams(symbols: string[]): Promise<void> {
  const ids = symbols.map(symbolIdFor).filter((id): id is number => id !== undefined);
  if (ids.length) await subscribeSpots(ids);
  await subscribeConversionPairs(symbols);
}

const SYMBOL_ALIASES: Record<string, string> = {
  AAVE: "AAVUSD",
  ALGO: "ALGUSD",
  AVAX: "AVAUSD",
  LINK: "LNKUSD",
};

// Parse the symbol arguments after the action (parts[0] = /symbols, parts[1] =
// add/remove). Accepts a comma and/or space separated list, e.g.
// "BTCUSD,ETHUSD POOPUSD", uppercased and de-duplicated.
function parseSymbols(parts: string[]): string[] {
  const syms = parts
    .slice(2)
    .join(" ")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(syms)];
}

export async function symbolsCmd(ctx: any) {
  const msg = ctx.message.text.trim();
  const parts = msg.split(/\s+/);

  // /symbols (no args) - list
  if (parts.length === 1) {
    if (state.settings.allowedSymbols.length === 0) {
      await ctx.reply("No symbols configured.");
      return;
    }
    await ctx.reply("Allowed symbols:\n" + state.settings.allowedSymbols.join("\n"));
    return;
  }

  const action = parts[1]?.toLowerCase();

  // /symbols reset - restore the default symbol list
  if (action === "reset") {
    state.settings.allowedSymbols = [...DEFAULT_SETTINGS.allowedSymbols];
    persistSettings();
    await ctx.reply(`Symbol list reset to defaults: ${state.settings.allowedSymbols.join(", ")}`);
    return;
  }

  // /symbols add all - add all symbols from the feed with confidence >= 50
  if (action === "add" && parts[2]?.toLowerCase() === "all") {
    try {
      const res = await fetch("https://signals.route07.com/alerts.json");
      const alerts = await res.json();
      const symbols = new Set<string>();
      for (const alert of alerts) {
        if (alert.confidence >= 50) {
          const base = alert.symbol.split("/")[0].toUpperCase();
          const resolved = SYMBOL_ALIASES[base] || `${base}USD`;
          symbols.add(resolved);
        }
      }
      let added = 0;
      const addedSyms: string[] = [];
      const skippedUnsupported: string[] = [];
      for (const sym of symbols) {
        if (isUnsupported(sym)) { skippedUnsupported.push(sym); continue; }
        if (!state.settings.allowedSymbols.includes(sym)) {
          state.settings.allowedSymbols.push(sym);
          addedSyms.push(sym);
          added++;
        }
      }
      persistSettings();
      await warmStreams(addedSyms);
      const skipNote = skippedUnsupported.length ? `\nSkipped ${skippedUnsupported.length} unsupported (cannot be valued in USD): ${skippedUnsupported.join(", ")}` : "";
      await ctx.reply(`Added ${added} symbols with confidence >= 50. Total allowed: ${state.settings.allowedSymbols.length}${skipNote}`);
    } catch (err: any) {
      await ctx.reply(`Failed to fetch feed: ${err.message}`);
    }
    return;
  }

  // /symbols add <SYM>[,<SYM>...] - one or more symbols, comma or space separated
  if (action === "add" && parts[2]) {
    const syms = parseSymbols(parts);
    const added: string[] = [];
    const already: string[] = [];
    const unsupported: string[] = [];
    for (const sym of syms) {
      if (isUnsupported(sym)) unsupported.push(sym);
      else if (state.settings.allowedSymbols.includes(sym)) already.push(sym);
      else { state.settings.allowedSymbols.push(sym); added.push(sym); }
    }
    if (added.length) { persistSettings(); await warmStreams(added); }
    const out: string[] = [];
    if (added.length) out.push(`Added: ${added.join(", ")}`);
    if (already.length) out.push(`Already present: ${already.join(", ")}`);
    if (unsupported.length) out.push(`Not added (cannot be valued in USD, unsupported): ${unsupported.join(", ")}`);
    out.push(`Allowed: ${state.settings.allowedSymbols.join(", ")}`);
    await ctx.reply(out.join("\n"));
    return;
  }

  // /symbols remove <SYM>[,<SYM>...] - one or more symbols, comma or space separated
  if (action === "remove" && parts[2]) {
    const syms = parseSymbols(parts);
    const removed: string[] = [];
    const notFound: string[] = [];
    for (const sym of syms) {
      const idx = state.settings.allowedSymbols.indexOf(sym);
      if (idx === -1) notFound.push(sym);
      else { state.settings.allowedSymbols.splice(idx, 1); removed.push(sym); }
    }
    if (removed.length) persistSettings();
    const out: string[] = [];
    if (removed.length) out.push(`Removed: ${removed.join(", ")}`);
    if (notFound.length) out.push(`Not in list: ${notFound.join(", ")}`);
    out.push(`Allowed: ${state.settings.allowedSymbols.join(", ")}`);
    await ctx.reply(out.join("\n"));
    return;
  }

  await ctx.reply("Usage: /symbols | /symbols add <SYM>[,<SYM>...] | /symbols add all | /symbols remove <SYM>[,<SYM>...] | /symbols reset");
}