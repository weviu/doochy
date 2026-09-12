import { useCallback, useEffect, useState } from "react";
import { Play, Pause, XOctagon, RefreshCw, AlertCircle, Signal, ChevronLeft, History as HistoryIcon } from "lucide-react";
import { api, type StatusData, type PositionsData, type PendingOrderRow, type Account } from "./lib/api";
import { notify } from "./lib/telegram";
import { Button, Card } from "./components/ui";
import { Dashboard } from "./components/Dashboard";
import { Positions } from "./components/Positions";
import { Settings } from "./components/Settings";
import { Trade } from "./components/Trade";
import { Signals } from "./components/Signals";
import { History } from "./components/History";
import { ConfirmModal } from "./components/Modal";

// The four bar tabs. "signals" and "history" are sub-pages reached from the
// dashboard buttons (with a Back control), not bar tabs.
type BarTab = "dashboard" | "positions" | "trade" | "settings";
type Tab = BarTab | "signals" | "history";

const POLL_MS = 5000;
// Remember the picked account across reloads; the account may vanish from the
// traded set, in which case the picker falls back to the first one.
const ACCOUNTS_KEY = "doochy.account";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  // Which bar tab to return to when leaving the signals sub-page.
  const [signalsFrom, setSignalsFrom] = useState<BarTab>("dashboard");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [positions, setPositions] = useState<PositionsData | null>(null);
  const [pending, setPending] = useState<PendingOrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // Load the traded accounts once at boot (the picker list). The stored pick is
  // kept only if it still exists; otherwise fall back to the first account.
  useEffect(() => {
    (async () => {
      try {
        const d = await api.accounts();
        setAccounts(d.accounts);
        const stored = localStorage.getItem(ACCOUNTS_KEY);
        const valid = d.accounts.some((a) => a.accountId === stored);
        setAccountId(valid ? stored : (d.accounts[0]?.accountId ?? null));
      } catch {
        // Accounts list unavailable (e.g. agent briefly offline): the rest of
        // the app still works, scoped to the agent's default account.
      }
    })();
  }, []);

  // Signal/history sections are global (they cover every traded account); the
  // account picker scopes the account-specific tabs — dashboard, positions,
  // trade, and settings (each account keeps its own risk/symbol/limit settings).
  const refresh = useCallback(async () => {
    const ctid = accountId ?? undefined;
    try {
      const [s, p] = await Promise.all([api.status(ctid), api.positions(ctid)]);
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
      const po = await api.pendingOrders(ctid);
      setPending(po.orders);
    } catch {
      /* keep last-known pending list */
    }
  }, [accountId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const paused = status?.paused ?? false;
  // A daily-limit lock (loss limit, profit cap, unconfirmed P&L seed, rollover)
  // is separate from the pause: an account can be locked while NOT paused. The
  // header control must show Resume for either state — otherwise a locked
  // account offers no way to resume and the button misleadingly says "Pause".
  const needsResume = paused || (status?.locked ?? false);

  // Only actually scoped/executing against the picked account. A single-account
  // bot hides the picker entirely; the app then simply means "the account".
  const onAccountChange = (id: string) => {
    setAccountId(id);
    localStorage.setItem(ACCOUNTS_KEY, id);
  };

  function openSignals(from: BarTab) {
    setSignalsFrom(from);
    setTab("signals");
  }

  async function togglePause() {
    try {
      if (needsResume) await api.resume(accountId ?? undefined);
      else await api.pause(accountId ?? undefined);
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
            <Button size="sm" variant={needsResume ? "primary" : "secondary"} onClickAsync={togglePause}>
              {needsResume ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {needsResume ? "Resume" : "Pause"}
            </Button>
          </div>
        </div>
        {/* Account picker: the whole mini-app is scoped to the selected account,
            so it sits below the action buttons and above the tabs. Hidden when
            the bot trades a single account (nothing to choose between), and
            only shown after accounts have loaded. */}
        {accounts.length > 1 && (
          <div className="mx-auto max-w-2xl px-4 pb-2">
            <label className="block text-[10px] font-medium uppercase tracking-wide text-fg-faint">
              Account
            </label>
            <select
              value={accountId ?? ""}
              onChange={(e) => onAccountChange(e.target.value)}
              className="mt-1 w-full appearance-none rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium tabular-nums text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.accountTag}
                </option>
              ))}
            </select>
          </div>
        )}
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

        {(tab === "signals" || tab === "history") && (
          <button
            onClick={() => setTab(tab === "signals" ? signalsFrom : "dashboard")}
            className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
        )}

        {tab === "dashboard" && <Dashboard status={status} accountId={accountId ?? undefined} />}
        {tab === "positions" && (
          <Positions data={positions} pending={pending} onChanged={refresh} accountId={accountId ?? undefined} onOpenSignals={() => openSignals("positions")} />
        )}
        {tab === "trade" && <Trade accountId={accountId ?? undefined} />}
        {tab === "settings" && <Settings status={status} accounts={accounts} accountId={accountId ?? undefined} />}
        {tab === "signals" && <Signals />}
        {tab === "history" && <History />}

        {/* Dashboard entry points: Signals and History side by side. */}
        {tab === "dashboard" && (
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" className="w-full" onClick={() => openSignals("dashboard")}>
              <Signal className="h-4 w-4" /> Signals
            </Button>
            <Button variant="secondary" size="lg" className="w-full" onClick={() => setTab("history")}>
              <HistoryIcon className="h-4 w-4" /> History
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
