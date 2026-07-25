import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
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
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs text-fg-faint">
                    <th className="px-3 py-2 font-medium">Symbol</th>
                    <th className="px-3 py-2 font-medium">Side</th>
                    <th className="px-3 py-2 font-medium">Closing time</th>
                    <th className="px-3 py-2 text-right font-medium">Entry</th>
                    <th className="px-3 py-2 text-right font-medium">Close</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Net USD</th>
                    <th className="px-3 py-2 font-medium">Closed by</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={`${t.time}-${t.symbol}-${i}`} className="border-b border-hairline/60 last:border-0">
                      <td className="px-3 py-2 font-semibold tracking-tight">{t.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge tone={t.side === "BUY" ? "success" : "danger"}>{t.side}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-muted">{t.time}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{price(t.entry)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{price(t.exit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{t.lots}</td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${t.netUsd >= 0 ? "text-success" : "text-danger"}`}>
                        {pnl(t.netUsd)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs text-fg-muted">{t.closedBy}</span>
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
