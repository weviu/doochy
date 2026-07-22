import { Activity, TrendingUp, TrendingDown, ShieldAlert, Timer } from "lucide-react";
import type { StatusData } from "../lib/api";
import { money, pnl, clampPct } from "../lib/format";
import { Card, Badge, Skeleton } from "./ui";
import { FadeRise, Stagger, StaggerItem } from "./motion";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-fg";
  return (
    <div>
      <div className="text-xs text-fg-faint">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${color}`}>{value}</div>
    </div>
  );
}

function Meter({ label, used, limit, tone }: { label: string; used: number; limit: number; tone: "accent" | "danger" }) {
  const pct = clampPct((used / limit) * 100);
  const bar = tone === "danger" ? "bg-danger" : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className="text-xs tabular-nums text-fg-faint">
          {money(used)} / {money(limit)}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
        <div className={`h-full rounded-full ${bar} transition-[width] duration-250`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Dashboard({ status }: { status: StatusData | null }) {
  if (!status) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const tradingBadge = status.locked ? (
    <Badge tone="danger">
      <ShieldAlert className="h-3.5 w-3.5" /> Locked
    </Badge>
  ) : status.paused ? (
    <Badge tone="muted">Paused</Badge>
  ) : (
    <Badge tone="success">
      <Activity className="h-3.5 w-3.5" /> Active
    </Badge>
  );

  return (
    <div className="space-y-6">
      <FadeRise>
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs text-fg-faint">Balance</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                {money(status.balance, status.currency)}
              </div>
              <div className="mt-1 text-xs text-fg-faint">
                Account {status.accountId} · {status.connected ? "connected" : "disconnected"}
              </div>
            </div>
            {tradingBadge}
          </div>
          {status.locked && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Trading locked{status.lockReason ? ` — ${status.lockReason}` : ""}. Resume, or wait for the midnight UTC reset.
              </span>
            </div>
          )}
          <div className="mt-6 grid grid-cols-2 gap-4">
            <Stat
              label="Daily realized"
              value={pnl(status.dailyRealizedPnL)}
              tone={status.dailyRealizedPnL >= 0 ? "success" : "danger"}
            />
            <Stat
              label="Floating"
              value={pnl(status.floatingPnL)}
              tone={status.floatingPnL >= 0 ? "success" : "danger"}
            />
          </div>
        </Card>
      </FadeRise>

      <FadeRise delay={0.05}>
        <Card className="space-y-4 p-6">
          <div className="text-sm font-semibold text-fg">Daily limits</div>
          {status.profitCapUSD > 0 ? (
            <Meter label="Profit cap" used={status.capUsed} limit={status.profitCapUSD} tone="accent" />
          ) : (
            <div className="text-xs text-fg-faint">Profit cap off</div>
          )}
          <Meter
            label="Daily loss"
            used={Math.max(0, -(status.dailyRealizedPnL + status.floatingPnL))}
            limit={status.maxLossUSD}
            tone="danger"
          />
        </Card>
      </FadeRise>

      <FadeRise delay={0.1}>
        <Stagger className="grid grid-cols-2 gap-3">
          <StaggerItem>
            <Card className="p-4">
              <div className="text-xs text-fg-faint">Open positions</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {status.openPositions}
                <span className="text-fg-faint">/{status.maxPositions}</span>
              </div>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="p-4">
              <div className="text-xs text-fg-faint">Risk / trade</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {status.riskPerTradeUSD > 0 ? money(status.riskPerTradeUSD) : "—"}
              </div>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="p-4">
              <div className="text-xs text-fg-faint">Allowed symbols</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{status.allowedSymbols.length}</div>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-xs text-fg-faint">
                {status.dailyRealizedPnL + status.floatingPnL >= 0 ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                Total P&L
              </div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${
                  status.dailyRealizedPnL + status.floatingPnL >= 0 ? "text-success" : "text-danger"
                }`}
              >
                {pnl(status.dailyRealizedPnL + status.floatingPnL)}
              </div>
            </Card>
          </StaggerItem>
        </Stagger>
      </FadeRise>

      {status.cooldowns.length > 0 && (
        <FadeRise delay={0.15}>
          <Card className="p-4">
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Timer className="h-3.5 w-3.5" /> Cooldowns
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {status.cooldowns.map((c) => (
                <Badge key={c.symbol} tone="muted">
                  {c.symbol} {Math.ceil(c.remainingMs / 60000)}m
                </Badge>
              ))}
            </div>
          </Card>
        </FadeRise>
      )}

      {status.reentryCooldowns.length > 0 && (
        <FadeRise delay={0.2}>
          <Card className="p-4">
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Timer className="h-3.5 w-3.5" /> Re-entry blocked
            </div>
            <div className="mt-1 text-xs text-fg-faint">Same symbol and direction after a loss.</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {status.reentryCooldowns.map((c) => (
                <Badge key={`${c.symbol}:${c.direction}`} tone="muted">
                  {c.symbol} {c.direction} {Math.ceil(c.remainingMs / 60000)}m
                </Badge>
              ))}
            </div>
          </Card>
        </FadeRise>
      )}
    </div>
  );
}
