import { useCallback, useEffect, useState } from "react";
import { Play, Pause, XOctagon, RefreshCw, AlertCircle, Signal, ChevronLeft } from "lucide-react";
import { api, type StatusData, type PositionsData, type PendingOrderRow } from "./lib/api";
import { notify } from "./lib/telegram";
import { Button, Card } from "./components/ui";
import { Dashboard } from "./components/Dashboard";
import { Positions } from "./components/Positions";
import { Settings } from "./components/Settings";
import { Trade } from "./components/Trade";
import { Signals } from "./components/Signals";
import { ConfirmModal } from "./components/Modal";

// The four bar tabs. "signals" is a sub-page reached from the dashboard button
// and the positions card (with a Back control), not a bar tab.
type BarTab = "dashboard" | "positions" | "trade" | "settings";
type Tab = BarTab | "signals";

const POLL_MS = 5000;

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  // Which bar tab to return to when leaving the signals sub-page.
  const [signalsFrom, setSignalsFrom] = useState<BarTab>("dashboard");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [positions, setPositions] = useState<PositionsData | null>(null);
  const [pending, setPending] = useState<PendingOrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.status(), api.positions()]);
      setStatus(s);
      setPositions(p);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      return;
    }
    // Resting orders are best-effort (a broker reconcile): a failure here must
    // not blank the dashboard, so keep the last-known list on error.
    try {
      const po = await api.pendingOrders();
      setPending(po.orders);
    } catch {
      /* keep last-known pending list */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const paused = status?.paused ?? false;

  function openSignals(from: BarTab) {
    setSignalsFrom(from);
    setTab("signals");
  }

  async function togglePause() {
    try {
      if (paused) await api.resume();
      else await api.pause();
      notify("success");
      await refresh();
    } catch (e: any) {
      notify("error");
      setError(e?.message || "Action failed");
    }
  }

  async function doCloseAll() {
    try {
      const r = await api.closeall();
      notify(r.failed > 0 ? "warning" : "success");
      await refresh();
    } catch (e: any) {
      notify("error");
      setError(e?.message || "Close all failed");
    }
  }

  return (
    <div className="min-h-screen bg-canvas">
      {/* Solid (not backdrop-blur): backdrop-filter re-blurs everything behind a
          sticky element on every scroll frame, which stutters badly in the
          Telegram mobile webview. An opaque header composites for free. */}
      <header className="sticky top-0 z-10 border-b border-hairline bg-canvas">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight">DoochyBot</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClickAsync={refresh} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" variant={paused ? "primary" : "secondary"} onClickAsync={togglePause}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {paused ? "Resume" : "Pause"}
            </Button>
          </div>
        </div>
        <div className="mx-auto flex max-w-2xl gap-1 pl-2 pr-4 pb-2">
          {(["dashboard", "positions", "trade", "settings"] as BarTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium capitalize transition " +
                (tab === t
                  ? "border border-accent/20 bg-accent-soft text-accent"
                  : "border border-transparent text-fg-muted hover:text-fg hover:bg-surface-hover")
              }
            >
              {t}
              {t === "positions" && status ? ` (${status.openPositions})` : ""}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        {error && (
          <Card className="mb-4 border-danger/30 bg-danger-soft p-4">
            <div className="flex items-center gap-2 text-sm text-danger">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          </Card>
        )}

        {tab === "signals" && (
          <button
            onClick={() => setTab(signalsFrom)}
            className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
        )}

        {tab === "dashboard" && <Dashboard status={status} />}
        {tab === "positions" && (
          <Positions data={positions} pending={pending} onChanged={refresh} onOpenSignals={() => openSignals("positions")} />
        )}
        {tab === "trade" && <Trade />}
        {tab === "settings" && <Settings status={status} />}
        {tab === "signals" && <Signals />}

        {/* Dashboard entry point to the signals page (replaces close-all here). */}
        {tab === "dashboard" && (
          <div className="mt-6">
            <Button variant="secondary" size="lg" className="w-full" onClick={() => openSignals("dashboard")}>
              <Signal className="h-4 w-4" /> Signals
            </Button>
          </div>
        )}

        {/* Close-all lives only on the positions tab now. */}
        {tab === "positions" && status && status.openPositions > 0 && (
          <div className="mt-6">
            <Button variant="danger" size="lg" className="w-full" onClick={() => setConfirmClose(true)}>
              <XOctagon className="h-4 w-4" /> Close all positions
            </Button>
          </div>
        )}
      </main>

      <ConfirmModal
        open={confirmClose}
        title="Close all positions?"
        body={`This immediately market-closes all ${status?.openPositions ?? 0} open position(s). This cannot be undone.`}
        confirmLabel="Close all"
        danger
        onConfirm={doCloseAll}
        onClose={() => setConfirmClose(false)}
      />
    </div>
  );
}
