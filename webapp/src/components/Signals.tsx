import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ArrowDownRight, CheckCircle2, XCircle } from "lucide-react";
import { api, type SignalRecord } from "../lib/api";
import { Card, Badge, Skeleton } from "./ui";
import { Stagger, StaggerItem, FadeRise } from "./motion";

const POLL_MS = 5000;
type Filter = "all" | "executed";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The signal log: every signal the gate evaluated, executed or rejected, newest
// first. A filter switch narrows to executed-only. Read-only.
export function Signals() {
  const [signals, setSignals] = useState<SignalRecord[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.signals();
      setSignals(d.signals);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load signals");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!signals) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const executedCount = signals.filter((s) => s.outcome === "executed").length;
  const shown = filter === "executed" ? signals.filter((s) => s.outcome === "executed") : signals;

  return (
    <div className="space-y-4">
      {error && (
        <FadeRise>
          <Card flat className="border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</Card>
        </FadeRise>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-faint">
          {signals.length} signal{signals.length !== 1 ? "s" : ""} · {executedCount} executed
        </span>
        <div className="flex gap-1">
          {(["all", "executed"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (filter === f
                  ? "border border-accent/20 bg-accent-soft text-accent"
                  : "border border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg")
              }
            >
              {f === "all" ? "All" : "Executed"}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <FadeRise>
          <Card flat className="p-8 text-center">
            <div className="text-sm text-fg-muted">
              {filter === "executed" ? "No executed signals yet" : "No signals yet"}
            </div>
          </Card>
        </FadeRise>
      ) : (
        <Stagger className="space-y-3">
          {shown.map((s, i) => (
            <StaggerItem key={`${s.receivedAt}-${i}`}>
              <SignalCard s={s} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function SignalCard({ s }: { s: SignalRecord }) {
  const isBuy = s.direction === "BUY";
  const executed = s.outcome === "executed";
  return (
    <Card flat className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={isBuy ? "success" : "danger"}>
            {isBuy ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {s.direction}
          </Badge>
          <span className="text-sm font-semibold tracking-tight">{s.symbol}</span>
          <span className="text-xs text-fg-faint">{s.timeframe}</span>
        </div>
        <span className={"inline-flex shrink-0 items-center gap-1 text-xs font-medium " + (executed ? "text-success" : "text-fg-muted")}>
          {executed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {executed ? "Executed" : "Rejected"}
        </span>
      </div>

      {s.reason && (
        <div className={"mt-2 text-xs " + (executed ? "text-fg-faint" : "text-fg-muted")}>{s.reason}</div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-fg-faint">
        <span>conf <span className="text-fg">{s.confidence}</span></span>
        <span>@ <span className="text-fg">{s.price}</span></span>
        <span>SL <span className="text-fg">{s.sl ?? "—"}</span></span>
        <span>TP <span className="text-fg">{s.tp ?? "—"}</span></span>
        {s.btcState && <span>BTC <span className="text-fg">{s.btcState}</span></span>}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-fg-faint">
        <span className="truncate">{s.source ?? s.signalSource ?? "Feed"}</span>
        <span className="shrink-0">{timeAgo(s.receivedAt)}</span>
      </div>
    </Card>
  );
}
