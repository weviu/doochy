import { symbolSpaceFor, invalidateSymbolResolution } from "../state";

// Load a broker's symbol list for ONE account into the account's own symbol
// space. Accounts can sit on different environments/brokers, so the name->id
// space is per-account: subscribing the wrong account's symbolId is a silent
// miss (no data ever arrives), caught only by a still-zero mark price.
export async function fetchSymbols(connection: any, ctid: number): Promise<void> {
  const space = symbolSpaceFor(ctid);

  // Asset id -> name (e.g. "USD", "JPY"), used to tell each symbol's quote
  // currency. Best-effort: if this fails we leave usd empty and isUsdQuoted
  // fails open (no worse than before the quote check existed).
  const assetName = new Map<number, string>();
  try {
    const assetsRes = await connection.sendCommand("ProtoOAAssetListReq", { ctidTraderAccountId: ctid });
    for (const a of assetsRes.asset || []) {
      if (a.assetId != null && a.name) assetName.set(Number(a.assetId), String(a.name).toUpperCase());
    }
    console.log(`[SYMBOLS] Account ${ctid}: loaded ${assetName.size} assets`);
  } catch (err: any) {
    console.warn(`[SYMBOLS] Could not fetch assets for account ${ctid} (quote-currency check disabled): ${err.message}`);
  }

  try {
    const res = await connection.sendCommand("ProtoOASymbolsListReq", {
      ctidTraderAccountId: ctid,
      includeArchivedSymbols: false,
    });

    space.ids.clear();
    space.usd.clear();
    space.quote.clear();
    space.disabled.clear();

    const symbols: any[] = res.symbol || [];
    let usdCount = 0;
    let disabledCount = 0;
    for (const s of symbols) {
      if (s.symbolName && s.symbolId) {
        const name = s.symbolName.toUpperCase();
        // Some brokers list symbols for all account types in ProtoOASymbolsListReq
        // but mark them enabled:false for accounts that can't trade them (prop-firm
        // Evaluation accounts typically see far fewer symbols than Live). Track
        // disabled ones so the "add all available" flow skips them.
        if (s.enabled === false) {
          space.disabled.add(name);
          disabledCount++;
          continue;
        }
        // The cTrader layer decodes int64 fields (symbolId) as STRINGS. Coerce to
        // Number so the space honours its declared Map<string, number> type. This
        // matters because the live-price quotes map is keyed by Number(symbolId);
        // a string here makes quotes.get(ids.get(sym)) silently miss, which is why
        // floating P&L read 0 (mark fell back to entry price).
        space.ids.set(name, Number(s.symbolId));
        // Record the QUOTE currency. USD-quoted symbols are valued directly; a
        // non-USD-quoted one (e.g. JPY for GBPJPY) is converted to USD via its
        // conversion pair (see quoteToUsd). quoteAssetId is on the light symbol.
        const quoteName = s.quoteAssetId != null ? assetName.get(Number(s.quoteAssetId)) : undefined;
        if (quoteName) {
          space.quote.set(name, quoteName);
          if (quoteName === "USD") {
            space.usd.add(name);
            usdCount++;
          }
        }
      }
    }
    // Rebuild the cross-broker canonical index against the freshly loaded list.
    invalidateSymbolResolution(ctid);
    console.log(`[SYMBOLS] Account ${ctid}: loaded ${space.ids.size} symbols (${usdCount} USD-quoted)${disabledCount ? `, ${disabledCount} trading-disabled` : ""}`);
  } catch (err: any) {
    console.warn(`[SYMBOLS] Could not fetch symbols for account ${ctid}: ${err.message}`);
  }
}