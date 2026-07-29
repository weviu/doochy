import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Download } from "lucide-react";
import { api, type CommandDocument } from "../lib/api";
import { notify } from "../lib/telegram";
import { pnl, price } from "../lib/format";
import { type ExportTrade, decodeTrades, todayUTC, downloadBase64 } from "../lib/trades";
import { Card, Badge, Skeleton, Button } from "./ui";
import { FadeRise } from "./motion";

// YYYY-MM-DD `days` before today, in UTC (matches the export command's day
// boundaries).
function daysAgoUTC(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// The export builds close time as "2026-07-23 14:45:07 UTC". Split it into a
// date "2026.07.23" (dots) and a time "14:45" (no seconds) so the cell can stack
// them on two lines, halving the column width. The "UTC" suffix is dropped here
// and shown once in the column header instead of on every row. Unrecognised
// shapes fall back to the whole string on the date line.
function fmtCloseTime(s: string): { date: string; time: string } {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):\d{2}/);
  if (!m) return { date: s, time: "" };
  const [, y, mo, d, hh, mm] = m;
  return { date: `${y}.${mo}.${d}`, time: `${hh}:${mm}` };
}

type SortKey = "symbol" | "side" | "time" | "net";

// Accessor + kind per sortable column. Text columns compare with localeCompare;
// `net` is numeric so it compares by value (a string compare would order
// "-$9" after "-$10"). `time` is the raw export string
// "YYYY-MM-DD HH:MM:SS UTC", whose lexical order is already chronological, so it
// sorts correctly as text without parsing a Date.
const SORT_COLUMN: Record<SortKey, { kind: "text"; get: (t: ExportTrade) => string } | { kind: "num"; get: (t: ExportTrade) => number }> = {
  symbol: { kind: "text", get: (t) => t.symbol },
  side: { kind: "text", get: (t) => t.side },
  time: { kind: "text", get: (t) => t.time },
  net: { kind: "num", get: (t) => t.netUsd },
};

// Closed-trade history, laid out like cTrader web's History tab: a per-trade
// table over a date range. The same data (api.exportTrades) also drives the
// stats + download in Settings; this view shows each trade individually.
export function History() {
  // Default to the last 7 days so the page has something to show on open, rather
  // than only today's closes.
  const [from, setFrom] = useState(daysAgoUTC(6));
  const [to, setTo] = useState(todayUTC());
  const [trades, setTrades] = useState<ExportTrade[] | null>(null);
  // The raw export document, kept so the same fetched data can be downloaded
  // without a second request.
  const [doc, setDoc] = useState<CommandDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Column sort. null key preserves the export's own order (chronological); a
  // header click sorts by that column and a second click on the same one flips
  // direction. Only the three text-ish columns are sortable per the design.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const rangeError = from > to ? "The start date must be on or before the end date." : null;

  const load = useCallback(async () => {
    if (from > to) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.exportTrades(from, to);
      // No document means no closed trades in range (the agent replies text).
      setTrades(res.document?.data ? decodeTrades(res.document.data) : []);
      setDoc(res.document ?? null);
    } catch (e: any) {
      setError(e?.message || "Could not load history");
      setTrades(null);
      setDoc(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  function download() {
    if (!doc) return;
    const ok = downloadBase64(doc);
    notify(ok ? "success" : "warning");
    if (!ok) setError("Your browser blocked the download. Use /export in the chat instead.");
  }

  const net = trades ? trades.reduce((sum, t) => sum + t.netUsd, 0) : 0;

  // Sorted view. Without an active sort the export's own order is kept. A copy is
  // sorted (never the source array) so clearing the sort restores the original.
  const rows = useMemo(() => {
    if (!trades || !sort) return trades ?? [];
    const col = SORT_COLUMN[sort.key];
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...trades].sort((a, b) => {
      const cmp =
        col.kind === "num" ? col.get(a) - col.get(b) : col.get(a).localeCompare(col.get(b));
      return factor * cmp;
    });
  }, [trades, sort]);

  // Toggle direction when re-clicking the active column, else sort that column
  // in its most useful default: text A->Z, but time newest-first and Net USD
  // biggest-first (both desc), since that is what a trader usually wants first.
  function toggleSort(key: SortKey) {
    setSort((cur) =>
      cur?.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "time" || key === "net" ? "desc" : "asc" }
    );
  }

  const dateInput =
    "w-full rounded-md border border-hairline bg-surface px-3 py-2 text-sm tabular-nums text-fg " +
    "focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-2 block text-sm font-medium text-fg-muted">From</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-fg-muted">To</label>
          <input type="date" value={to} min={from} max={todayUTC()} onChange={(e) => setTo(e.target.value)} className={dateInput} />
        </div>
      </div>

      {rangeError && <Card flat className="border-danger/30 bg-danger-soft p-3 text-sm text-danger">{rangeError}</Card>}
      {error && <Card flat className="border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</Card>}

      {loading && !trades ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : trades && trades.length > 0 ? (
        <>
          <div className="flex items-center justify-between gap-3 px-1 text-sm">
            <span className="text-fg-muted">{trades.length} closed trade{trades.length !== 1 ? "s" : ""}</span>
            <div className="flex items-center gap-3">
              <span className="text-fg-muted">
                Net{" "}
                <span className={`font-semibold tabular-nums ${net >= 0 ? "text-success" : "text-danger"}`}>{pnl(net)}</span>
              </span>
              {doc && (
                <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={download}>
                  Export
                </Button>
              )}
            </div>
          </div>

          <Card flat className="overflow-hidden">
            {/* Wide table: scroll horizontally inside the card on narrow screens
                so the page body never overflows sideways. */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs text-fg-faint">
                    <SortableTh label="Symbol" col="symbol" sort={sort} onSort={toggleSort} />
                    <SortableTh label="Side" col="side" sort={sort} onSort={toggleSort} />
                    <SortableTh label="Closing time (UTC)" col="time" sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-2 text-right font-medium">Entry</th>
                    <th className="px-3 py-2 text-right font-medium">Close</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <SortableTh label="Net USD" col="net" sort={sort} onSort={toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t, i) => (
                    <tr key={`${t.time}-${t.symbol}-${i}`} className="border-b border-hairline/60 last:border-0">
                      <td className="px-3 py-2 font-semibold tracking-tight">{t.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge tone={t.side === "BUY" ? "success" : "danger"}>{t.side}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums leading-tight text-fg-muted">
                        {(() => {
                          const { date, time } = fmtCloseTime(t.time);
                          return (
                            <>
                              <div>{date}</div>
                              {time && <div className="text-fg-faint">{time}</div>}
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{price(t.entry)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{price(t.exit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{t.lots}</td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${t.netUsd >= 0 ? "text-success" : "text-danger"}`}>
                        {pnl(t.netUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <FadeRise>
          <Card flat className="p-8 text-center">
            <div className="text-sm text-fg-muted">No closed trades in that range</div>
          </Card>
        </FadeRise>
      )}
    </div>
  );
}

// A clickable column header. Shows a direction chevron only on the active sort
// column, so the table stays quiet until the user chooses an ordering.
function SortableTh({
  label,
  col,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort?.key === col;
  const chevron =
    active && (sort!.dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />);
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-label={`Sort by ${label}`}
        className={`-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-fg ${active ? "text-fg" : ""}`}
      >
        {/* For the right-aligned numeric column, the chevron leads so the group
            hugs the right edge and reads naturally next to the values below. */}
        {align === "right" && chevron}
        {label}
        {align === "left" && chevron}
      </button>
    </th>
  );
}
