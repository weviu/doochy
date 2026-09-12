import { settingsFor, persistAccountSettings, DEFAULT_SETTINGS, symbolIdFor, enabledSymbolNames, runtimeFor } from "../../state";
import { subscribeSpots, subscribeConversionPairs, canValueInUsd } from "../../ctrader/livePrices";
import { fetchFeed } from "../../signals/poller";
import { commandAccount, accountListText } from "./account";
import { accountLabel } from "../../ctrader/brokerDirectory";

// A symbol is unsupported if the broker knows it (resolvable) but it can't be valued
// in USD: neither USD-quoted nor a non-USD pair with a conversion pair on the broker.
// The money model needs one of those to convert P&L/risk into dollars. Symbols the
// broker doesn't know are left alone here (the gate rejects them at trade time as
// "not available on broker"), so a typo isn't misreported as unsupported. Scoped to
// ONE account's broker (accounts can sit on different brokers).
function isUnsupported(sym: string, ctid: number): boolean {
  return symbolIdFor(sym, ctid) !== undefined && !canValueInUsd(sym, ctid);
}

// Warm the spot and USD-conversion streams for freshly added symbols on ONE
// account, so a JPY/CAD pair can be valued (and traded) without waiting for a bot
// restart to pre-subscribe. Subscriptions are account-scoped, so the account the
// symbols were added for is the account that gets them.
async function warmStreams(ctid: number, symbols: string[]): Promise<void> {
  const rt = runtimeFor(ctid);
  const ids = symbols.map((s) => symbolIdFor(s, ctid)).filter((id): id is number => id !== undefined);
  if (ids.length) await subscribeSpots(rt, ids);
  await subscribeConversionPairs(rt, symbols);
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
  const acc = commandAccount(ctx, msg.split(/\s+/));
  const parts = acc.parts;

  // /symbols (no args) - list. With an account arg, that account's list; on a
  // single-account bot, the one list; on a multi-account bot without an arg,
  // the default account's list (the view the mini-app's default selection
  // shows) — it is a read, so no "which account?" error here.
  if (parts.length === 1) {
    const s = settingsFor(acc.ctid);
    const header = acc.multi && acc.ctid !== undefined ? `Symbols (${accountLabel(acc.ctid) ?? acc.ctid}):\n` : "Allowed symbols:\n";
    await ctx.reply(s.allowedSymbols.length === 0 ? "No symbols configured." : `${header}${s.allowedSymbols.join("\n")}`);
    return;
  }

  const action = parts[1]?.toLowerCase();

  // Mutations need a target account.
  if (acc.ctid === undefined) {
    await ctx.reply(`Which account? Append a login or ctid: /symbols ${action} ... <login>. Accounts: ${accountListText()}`);
    return;
  }
  const ctid = acc.ctid;
  const s = settingsFor(ctid);
  const persist = () => persistAccountSettings(ctid);
  const tag = acc.multi ? ` (${accountLabel(ctid) ?? ctid})` : "";

  // /symbols reset - restore the default symbol list
  if (action === "reset") {
    s.allowedSymbols = [...DEFAULT_SETTINGS.allowedSymbols];
    persist();
    await ctx.reply(`Symbol list reset to defaults: ${s.allowedSymbols.join(", ")}${tag}`);
    return;
  }

  // /symbols add all - add all symbols from the feed with confidence >= 50
  if (action === "add" && parts[2]?.toLowerCase() === "all") {
    try {
      // Read the scanner feed (same source the poller consumes).
      const alerts = await fetchFeed();
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
        if (isUnsupported(sym, ctid)) { skippedUnsupported.push(sym); continue; }
        if (!s.allowedSymbols.includes(sym)) {
          s.allowedSymbols.push(sym);
          addedSyms.push(sym);
          added++;
        }
      }
      persist();
      await warmStreams(ctid, addedSyms);
      const skipNote = skippedUnsupported.length ? `\nSkipped ${skippedUnsupported.length} unsupported (cannot be valued in USD): ${skippedUnsupported.join(", ")}` : "";
      await ctx.reply(`Added ${added} symbols with confidence >= 50. Total allowed: ${s.allowedSymbols.length}${skipNote}${tag}`);
    } catch (err: any) {
      await ctx.reply(`Failed to fetch feed: ${err.message}`);
    }
    return;
  }

  // /symbols add broker - add all USD-valued symbols the connected broker offers
  if (action === "add" && parts[2]?.toLowerCase() === "broker") {
    const allBrokerSyms = [...new Set(
      enabledSymbolNames(ctid)
        .filter((s) => !s.includes("."))
        .map((s) => s.replace(/USDT$/, "USD"))
    )];
    const addedSyms: string[] = [];
    const skippedUnsupported: string[] = [];
    const skippedAlready: string[] = [];
    for (const sym of allBrokerSyms) {
      if (!canValueInUsd(sym, ctid)) { skippedUnsupported.push(sym); continue; }
      if (s.allowedSymbols.includes(sym)) { skippedAlready.push(sym); continue; }
      s.allowedSymbols.push(sym);
      addedSyms.push(sym);
    }
    if (addedSyms.length) { persist(); await warmStreams(ctid, addedSyms); }
    const out: string[] = [];
    out.push(`Added ${addedSyms.length} symbols. Total allowed: ${s.allowedSymbols.length}${tag}`);
    if (skippedAlready.length) out.push(`Already present: ${skippedAlready.length} symbol(s)`);
    if (skippedUnsupported.length) out.push(`Skipped ${skippedUnsupported.length} unsupported (cannot be valued in USD)`);
    await ctx.reply(out.join("\n"));
    return;
  }

  // /symbols add <SYM>[,<SYM>...] - one or more symbols, comma or space separated
  if (action === "add" && parts[2]) {
    const syms = parseSymbols(parts);
    const added: string[] = [];
    const already: string[] = [];
    const unsupported: string[] = [];
    const unknown: string[] = [];
    for (const sym of syms) {
      // A symbol the broker doesn't know at all (typo like "BTCUS") must be
      // rejected here, not silently accepted and left to fail at trade time.
      if (symbolIdFor(sym, ctid) === undefined) unknown.push(sym);
      else if (isUnsupported(sym, ctid)) unsupported.push(sym);
      else if (s.allowedSymbols.includes(sym)) already.push(sym);
      else { s.allowedSymbols.push(sym); added.push(sym); }
    }
    if (added.length) { persist(); await warmStreams(ctid, added); }
    const out: string[] = [];
    if (added.length) out.push(`Added: ${added.join(", ")}`);
    if (already.length) out.push(`Already present: ${already.join(", ")}`);
    if (unknown.length) out.push(`Not added (not a symbol on this broker): ${unknown.join(", ")}`);
    if (unsupported.length) out.push(`Not added (cannot be valued in USD, unsupported): ${unsupported.join(", ")}`);
    out.push(`Allowed: ${s.allowedSymbols.join(", ")}${tag}`);
    await ctx.reply(out.join("\n"));
    return;
  }

  // /symbols remove <SYM>[,<SYM>...] - one or more symbols, comma or space separated
  if (action === "remove" && parts[2]) {
    const syms = parseSymbols(parts);
    const removed: string[] = [];
    const notFound: string[] = [];
    for (const sym of syms) {
      const idx = s.allowedSymbols.indexOf(sym);
      if (idx === -1) notFound.push(sym);
      else { s.allowedSymbols.splice(idx, 1); removed.push(sym); }
    }
    if (removed.length) persist();
    const out: string[] = [];
    if (removed.length) out.push(`Removed: ${removed.join(", ")}`);
    if (notFound.length) out.push(`Not in list: ${notFound.join(", ")}`);
    out.push(`Allowed: ${s.allowedSymbols.join(", ")}${tag}`);
    await ctx.reply(out.join("\n"));
    return;
  }

  await ctx.reply("Usage: /symbols | /symbols add <SYM>[,<SYM>...] | /symbols add all | /symbols add broker | /symbols remove <SYM>[,<SYM>...] | /symbols reset");
}