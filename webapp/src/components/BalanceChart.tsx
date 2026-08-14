import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Info, Loader2 } from "lucide-react";
import { api, type BalanceHistoryData } from "../lib/api";
import { Card, Button } from "./ui";

function formatTick(ts: number): string {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${d.toLocaleString("default", { month: "short" })} ${d.getFullYear()} ${hours}:${minutes}`;
}

function ReferenceLabel({ viewBox, text, value }: any) {
  const { cx = 0, cy = 0 } = viewBox || {};
  const display = `${text} $${Number(value).toFixed(0)}`;
  const width = Math.min(160, Math.max(90, display.length * 6 + 14));
  return (
    <g transform={`translate(${cx},${cy})`}>
      <rect
        x={6}
        y={-21}
        width={width}
        height={16}
        rx={4}
        fill="rgb(var(--surface))"
        stroke="rgb(var(--line) / 0.14)"
      />
      <text
        x={12}
        y={-9}
        fill="rgb(var(--text) / 0.9)"
        fontSize={10}
        fontWeight={500}
        textAnchor="start"
      >
        {display}
      </text>
    </g>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const balance = payload[0].value as number;
  return (
    <div className="rounded-md border border-hairline bg-surface px-2.5 py-1.5 shadow-card">
      <div className="text-xs font-semibold text-fg tabular-nums">${balance.toFixed(2)}</div>
      <div className="text-[10px] text-fg-faint">{formatTick(Number(label))}</div>
    </div>
  );
}

export function BalanceChart({ initialBalanceUSD }: { initialBalanceUSD: number }) {
  const [data, setData] = useState<BalanceHistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSet, setJustSet] = useState(false);

  const load = async () => {
    if (initialBalanceUSD <= 0 && !justSet) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.balanceHistory(7);
      setData(res);
    } catch (e: any) {
      setError(e?.message || "Could not load balance history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Refresh every 60 seconds while the dashboard is open.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBalanceUSD]);

  const saveInitial = async () => {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a positive starting balance");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.command("balance", ["init", String(value)]);
      setDraft("");
      setJustSet(true);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (initialBalanceUSD <= 0 && !justSet) {
    return (
      <Card className="p-5">
        <div className="text-sm font-semibold text-fg">Balance history</div>
        <p className="mt-1 text-xs text-fg-faint">
          Set your starting account size so the chart can draw the fixed "Account size" reference
          line.
        </p>
        <div className="mt-4 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs font-medium text-fg-muted">Starting balance</label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-fg-faint">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="10000"
                className="w-full rounded-md border border-hairline bg-surface py-2 pl-6 pr-3 text-sm text-fg tabular-nums placeholder:text-fg-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          </div>
          <Button onClick={saveInitial} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Set
          </Button>
        </div>
        {error && <div className="mt-3 text-xs text-danger">{error}</div>}
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <Card className="h-[360px] p-5">
        <div className="text-sm font-semibold text-fg">Balance history</div>
        <div className="mt-4 h-[280px] animate-pulse rounded-md bg-surface-hover" />
      </Card>
    );
  }

  if (error || !data || data.points.length < 2) {
    return (
      <Card className="p-5">
        <div className="text-sm font-semibold text-fg">Balance history</div>
        <div className="mt-4 rounded-md border border-hairline bg-surface-hover p-4 text-xs text-fg-muted">
          {error
            ? error
            : `Current balance: $${data?.currentBalance.toFixed(2) ?? "--"}. Not enough history yet — the chart will appear once there are trades or transfers.`}
        </div>
      </Card>
    );
  }

  const { points, accountSize, currentBalance } = data;
  const balances = points.map((p) => p.balance);
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);
  const range = Math.max(maxBalance - minBalance, accountSize * 0.02);
  const yMin = Math.min(minBalance - range * 0.05, accountSize - range * 0.05);
  const yMax = Math.max(maxBalance + range * 0.05, accountSize + range * 0.05);

  const startTs = points[0].timestamp;
  const endTs = points[points.length - 1].timestamp;
  const xTicks = [startTs, Math.round((startTs + endTs) / 2), endTs];

  const chartData = useMemo(
    () => points.map((p) => ({ ...p, accountSize, currentBalance })),
    [points, accountSize, currentBalance]
  );

  return (
    <Card className="p-5">
      <div className="text-sm font-semibold text-fg">Balance history</div>
      <div className="mt-1 text-xs text-fg-faint">
        Account size{" "}
        <span className="font-medium text-fg">${accountSize.toFixed(2)}</span> · Current{" "}
        <span className="font-medium text-fg">${currentBalance.toFixed(2)}</span>
      </div>

      <div className="mt-4 h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 24, right: 12, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="balanceStroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity={1} />
                <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity={0.6} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgb(var(--line) / 0.09)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={[startTs, endTs]}
              ticks={xTicks}
              tickFormatter={formatTick}
              tick={{ fill: "rgb(var(--text) / 0.5)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[yMin, yMax]}
              tickFormatter={(v: number) => `$${Math.round(v)}`}
              tick={{ fill: "rgb(var(--text) / 0.5)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgb(var(--text) / 0.2)" }} />
            {accountSize > minBalance && (
              <ReferenceArea
                y1={accountSize}
                y2={minBalance}
                fill="rgb(var(--accent))"
                fillOpacity={0.06}
                strokeOpacity={0}
              />
            )}
            <ReferenceLine
              y={accountSize}
              stroke="rgb(var(--text) / 0.5)"
              strokeDasharray="3 3"
              label={<ReferenceLabel text="Account size" />}
            />
            <ReferenceLine
              y={currentBalance}
              stroke="rgb(var(--accent))"
              strokeDasharray="3 3"
              label={<ReferenceLabel text="Balance" />}
            />
            <Line
              type="stepAfter"
              dataKey="balance"
              stroke="url(#balanceStroke)"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: "rgb(var(--accent))" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-hairline bg-surface px-3 py-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <p className="text-[11px] leading-relaxed text-fg-muted">
          Balance history is reconstructed from your closed trades and cash-flow records, working
          backwards from your current balance.
        </p>
      </div>
    </Card>
  );
}
