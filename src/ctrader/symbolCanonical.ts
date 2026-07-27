// Broker-agnostic symbol canonicalisation.
//
// Different cTrader brokers spell the same market differently. Indices are the
// worst: one broker's "US TECH 100" is another's "US100" and another's
// "USTEC100" - there is no standard name. Copy-trade alerts carry the SOURCE
// broker's spelling (whatever the person who took the trade sees), while scanner
// alerts carry a short canonical one, and every consuming bot must map either
// spelling onto ITS OWN broker's exact symbol name before it can place an order.
//
// This module reduces any spelling to a single canonical key, so a name written
// by one broker's feed can be matched against the loaded symbol list of a
// different broker (see brokerNameFor in state.ts). FX pairs, metals and crypto
// already share a de-facto standard spelling (EURUSD, XAUUSD, BTCUSD), so only
// indices need an explicit synonym table.

// Each canonical token lists every index spelling seen across brokers/feeds for
// that one market. Add a broker's spelling here if it ever names an index we
// trade differently; nothing else has to change. Spellings are matched
// space-insensitively and case-insensitively (see canonicalSymbolKey), so a
// space variant like "US 100" does not need its own entry once "US100" is here.
//
// Deliberately restricted to NUMBERED / prefixed forms. Bare words like "DOW",
// "NASDAQ", "FTSE" or "DAX" are omitted on purpose: several brokers also list a
// company stock under those exact names (Dow Inc, Nasdaq Inc, ...), and mapping
// the bare word to an index token would make the stock resolve to the index.
const INDEX_SYNONYMS: Record<string, string[]> = {
  US100: ["US100", "USTECH100", "USTEC", "USTEC100", "NAS100", "NASDAQ100", "USNAS100", "USTECH"],
  US30: ["US30", "DJ30", "DOW30", "WS30", "US30CASH", "WALLSTREET"],
  US500: ["US500", "SPX500", "SP500", "USSPX500", "US500CASH"],
  GER40: ["GER40", "GERMANY40", "DE40", "DAX40", "DE30", "DAX30", "GER30"],
  UK100: ["UK100", "FTSE100", "UK100CASH"],
  EU50: ["EU50", "EUROPE50", "STOXX50", "EUSTX50", "ESX50"],
  JP225: ["JP225", "JPN225", "NIKKEI225", "JAPAN225"],
  AUS200: ["AUS200", "AU200", "ASX200", "AUSTRALIA200"],
};

// spelling-key (space-stripped, uppercased) -> canonical token. Built once at load.
const ALIAS_TO_TOKEN = new Map<string, string>();
for (const [token, spellings] of Object.entries(INDEX_SYNONYMS)) {
  ALIAS_TO_TOKEN.set(token, token); // the token itself is a valid spelling
  for (const s of spellings) ALIAS_TO_TOKEN.set(s.replace(/\s+/g, "").toUpperCase(), token);
}

// Reduce a symbol name (a broker spelling OR a feed spelling) to a canonical key
// that is identical across brokers for the same market. A known index spelling
// collapses to its token; everything else reduces to its space-stripped,
// uppercased form, which is already stable for FX/metals/crypto (EURUSD, XAUUSD).
export function canonicalSymbolKey(name: string): string {
  const stripped = name.replace(/\s+/g, "").toUpperCase();
  return ALIAS_TO_TOKEN.get(stripped) ?? stripped;
}
