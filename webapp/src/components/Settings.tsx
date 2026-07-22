import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Download, Plus, RotateCcw, Timer } from "lucide-react";
import { pnl } from "../lib/format";
import { api, type CommandDocument, type Settings as SettingsData, type StatusData } from "../lib/api";
import { notify } from "../lib/telegram";
import { Button, Chip, Flash, NumberField, SectionCard, Skeleton, Toggle } from "./ui";
import { FadeRise } from "./motion";
import { ConfirmModal } from "./Modal";

// Today's date as YYYY-MM-DD in UTC, matching the export command's own day
// boundaries (it treats the range in UTC).
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// Trigger a browser download of a base64 file. Returns false if the environment
// blocks it (some in-app webviews do), so the caller can fall back to a message.
function downloadBase64(doc: CommandDocument): boolean {
  try {
    const bytes = atob(doc.data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

// The settings control panel. Every field maps to the exact Telegram command
// its handler expects (src/bot/commands/*), relayed through /api/command so the
// panel and the chat behave identically. After each change we refresh from the
// settings snapshot the relay returns, so the UI always reflects agent truth.

export function Settings({ status }: { status: StatusData | null }) {
  const [s, setS] = useState<SettingsData | null>(null);
  const [flash, setFlash] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [addSym, setAddSym] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  // A message shown inline in the Symbols section (the add/remove result),
  // separate from the page-top flash so it's visible right where you're typing.
  const [symMsg, setSymMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await api.settings());
    } catch (e: any) {
      showFlash("danger", e?.message || "Failed to load settings");
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (symMsgTimer.current) clearTimeout(symMsgTimer.current);
    };
  }, [load]);

  function showFlash(tone: "success" | "danger", text: string) {
    setFlash({ tone, text });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 5000);
  }

  function showSymMsg(tone: "success" | "danger", text: string) {
    setSymMsg({ tone, text });
    if (symMsgTimer.current) clearTimeout(symMsgTimer.current);
    symMsgTimer.current = setTimeout(() => setSymMsg(null), 5000);
  }

  // Run one command, surface its reply, and refresh settings from the snapshot
  // the relay returns (falling back to a re-fetch if none came back).
  const run = useCallback(async (cmd: string, args: string[]) => {
    try {
      const res = await api.command(cmd, args);
      if (res.settings) setS(res.settings);
      else await load();
      // The relay returns 200 even when a handler declines the change (e.g. an
      // unknown symbol, an out-of-range value). Treat a "not added / not a /
      // must be" style reply as a soft failure so it flashes red, not green.
      const rejected = /\bnot added\b|\bnot a\b|\bmust be\b|\bunknown\b|\binvalid\b|\bfailed\b/i.test(res.text);
      notify(rejected ? "error" : "success");
      showFlash(rejected ? "danger" : "success", res.text);
    } catch (e: any) {
      notify("error");
      showFlash("danger", e?.message || "Command failed");
      throw e; // let the calling control clear its own loading state
    }
  }, [load]);

  if (!s) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const cooldowns = status?.cooldowns ?? [];

  return (
    <div className="space-y-6">
      {flash && <FadeRise><Flash tone={flash.tone}>{flash.text}</Flash></FadeRise>}

      {/* ---- Risk & sizing ---------------------------------------------------*/}
      <SectionCard title="Risk & sizing" description="How each trade is sized.">
        <NumberField
          label="Per-trade risk"
          help="Max $ lost if a stop is hit. Required to trade (0 = off)."
          value={s.riskPerTradeUSD}
          suffix="$"
          min={0}
          onSave={(n) => run("risk", ["pertrade", String(n)])}
        />
        <NumberField
          label="Max positions"
          help="Concurrent open positions (1-20)."
          value={s.maxPositions}
          min={1}
          max={20}
          onSave={(n) => run("risk", ["maxpos", String(n)])}
        />
        <NumberField
          label="Min hold"
          help="Seconds to hold before the TP is set (0 = immediate)."
          value={s.minHoldSeconds}
          suffix="s"
          min={0}
          max={3600}
          onSave={(n) => run("minhold", [String(n)])}
        />
      </SectionCard>

      {/* ---- Daily limits ---------------------------------------------------*/}
      <SectionCard title="Daily limits" description="Force close all guards.">
        <NumberField
          label="Daily loss limit"
          help="Closes everything and stops for the day when hit."
          value={s.maxDailyLossUSD}
          suffix="$"
          min={1}
          onSave={(n) => run("risk", ["maxloss", String(n)])}
        />
        <NumberField
          label="Profit cap"
          help="Closes everything once profit reaches this (0 = off)."
          value={s.dailyProfitCapUSD}
          suffix="$"
          min={0}
          onSave={(n) => run("risk", ["cap", String(n)])}
        />
        <NumberField
          label="Cap buffer"
          help="Trigger the cap this many $ early so a spike can't overshoot it."
          value={s.capBufferUSD}
          suffix="$"
          min={0}
          onSave={(n) => run("risk", ["capbuffer", String(n)])}
        />
      </SectionCard>

      {/* ---- Symbols --------------------------------------------------------*/}
      <SectionCard title="Symbols" description={`${s.allowedSymbols.length} allowed.`}>
        {symMsg && <Flash tone={symMsg.tone}>{symMsg.text}</Flash>}
        <div className="flex flex-wrap gap-2">
          {s.allowedSymbols.length === 0 && (
            <span className="text-xs text-fg-faint">None. Add one below.</span>
          )}
          {s.allowedSymbols.map((sym) => (
            <Chip key={sym} onRemove={() => run("symbols", ["remove", sym])}>{sym}</Chip>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={addSym}
            onChange={(e) => setAddSym(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && addSym.trim()) addSymbol(); }}
            placeholder="e.g. XAUUSD"
            className="flex-1 rounded-md border border-hairline bg-surface px-3 py-2 text-sm uppercase text-fg placeholder:text-fg-faint placeholder:normal-case focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <Button
            size="md"
            variant="primary"
            icon={<Plus className="h-4 w-4" />}
            disabled={!addSym.trim()}
            onClickAsync={addSym.trim() ? addSymbol : undefined}
          >
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </Button>
        </div>
      </SectionCard>

      {/* ---- Cooldowns & prop rules -----------------------------------------*/}
      <SectionCard
        title="Cooldowns & prop rules"
        description="Consecutive loss and per trade idea protections."
      >
        {cooldowns.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
              <Timer className="h-3.5 w-3.5" /> Active cooldowns
            </div>
            <div className="flex flex-wrap gap-2">
              {cooldowns.map((c) => (
                <Chip key={c.symbol}>{c.symbol} {Math.ceil(c.remainingMs / 60000)}m</Chip>
              ))}
            </div>
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClickAsync={() => run("cooldown", ["reset"])}>
                Clear all cooldowns
              </Button>
            </div>
          </div>
        )}
        <NumberField
          label="Consecutive losses"
          help="SL hits on one symbol in the window that trigger a cooldown (0 = off)."
          value={s.maxConsecutiveLosses}
          min={0}
          max={20}
          onSave={(n) => run("risk", ["losses", String(n)])}
        />
        <NumberField
          label="Loss window"
          help="Rolling window for counting SL hits."
          value={s.lossWindowMinutes}
          suffix="m"
          min={1}
          max={1440}
          onSave={(n) => run("risk", ["losswindow", String(n)])}
        />
        <NumberField
          label="Cooldown"
          help="How long a symbol is paused after the streak."
          value={s.cooldownMinutes}
          suffix="m"
          min={1}
          max={1440}
          onSave={(n) => run("risk", ["cooldown", String(n)])}
        />
        <NumberField
          label="Re-entry cooldown"
          help="Block reopening the same symbol+direction after a loss (0 = off)."
          value={s.reentryCooldownMinutes}
          suffix="m"
          min={0}
          max={1440}
          onSave={(n) => run("risk", ["reentry", String(n)])}
        />
        <NumberField
          label="Combined risk limit"
          help="Cap summed risk of all positions in one symbol+direction (0 = off)."
          value={s.maxCombinedRiskUSD}
          suffix="$"
          min={0}
          onSave={(n) => run("risk", ["combined", String(n)])}
        />
      </SectionCard>

      {/* ---- Signal gates ---------------------------------------------------*/}
      <SectionCard
        title="Signal gates"
        description="Which signals are allowed through."
        defaultOpen={false}
      >
        <NumberField
          label="Min confidence"
          help="Reject feed signals below this; channel signals bypass it (0 = off)."
          value={s.minConfidence}
          min={0}
          max={100}
          onSave={(n) => run("risk", ["minconfidence", String(n)])}
        />
        <Toggle
          label="Margin-aware sizing"
          help="Cap each order to fit free margin."
          checked={s.marginAware}
          onToggle={(on) => run("risk", ["marginaware", on ? "on" : "off"])}
        />
      </SectionCard>

      {/* ---- Trade history --------------------------------------------------*/}
      <SectionCard title="Trade history" description="Performance stats and export for closed trades.">
        <TradeHistorySection />
      </SectionCard>

      {/* ---- Notifications --------------------------------------------------*/}
      <SectionCard
        title="Notifications"
        description="Telegram alerts."
        defaultOpen={false}
      >
        <Toggle
          label="Order fills"
          help="Message you when an order fills."
          checked={s.notifyFills}
          onToggle={(on) => run("notifications", [on ? "on" : "off"])}
        />
        <Toggle
          label="Signal notifications"
          help="Message you for every incoming signal, executed or not."
          checked={s.signalNotify}
          onToggle={(on) => run("notifications", ["signals", on ? "on" : "off"])}
        />
        {s.signalNotify && (
          <NumberField
            label="Signal min confidence"
            help="Only notify on signals scoring at least this."
            value={s.signalNotifyMinConfidence}
            min={0}
            max={100}
            onSave={(n) => run("notifications", ["signals", "min", String(n)])}
          />
        )}
      </SectionCard>

      <ConfirmModal
        open={confirmReset}
        title="Reset symbols?"
        body="This restores the default symbol list (BTCUSD, XAUUSD, XAGUSD) and drops any you added."
        confirmLabel="Reset"
        danger
        onConfirm={() => run("symbols", ["reset"])}
        onClose={() => setConfirmReset(false)}
      />
    </div>
  );

  async function addSymbol() {
    const sym = addSym.trim().toUpperCase();
    if (!sym) return;
    const wasPresent = s?.allowedSymbols?.includes(sym) ?? false;
    try {
      const res = await api.command("symbols", ["add", sym]);
      if (res.settings) setS(res.settings);
      else await load();
      // Source of truth: did the symbol actually land in the allowed list? If
      // the agent refused it (unknown symbol, can't value in USD), it won't be
      // there, so show a clear warning instead of the verbose relay text.
      const nowPresent = res.settings?.allowedSymbols?.includes(sym);
      if (nowPresent && !wasPresent) {
        notify("success");
        showSymMsg("success", `Added ${sym}.`);
        setAddSym("");
      } else if (nowPresent) {
        notify("warning");
        showSymMsg("danger", `${sym} is already in the list.`);
      } else {
        notify("error");
        showSymMsg("danger", `${sym} is not a valid symbol. Check the spelling (e.g. XAUUSD, BTCUSD).`);
        // Keep the input so the user can correct the typo.
      }
    } catch (e: any) {
      notify("error");
      showSymMsg("danger", e?.message || "Could not add symbol");
    }
  }
}

// One closed trade as the /export command builds it (src/bot/commands/export.ts).
interface ExportTrade {
  time: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  entry: number | null;
  exit: number | null;
  netUsd: number; // net of commission + swap
  timeHeld: string; // "1d 2h", "45m", or "unknown"
  closedBy: string; // "TP" | "SL" | "stop-out" | "market"
}

interface HistoryStats {
  count: number;
  net: number;
  wins: number;
  losses: number;
  avgHoldMs: number | null;
  exits: { TP: number; SL: number; "stop-out": number; market: number };
  bySymbol: { symbol: string; count: number; net: number }[];
}

// Decode the base64 JSON the export command returns into the trades array. The
// same document also feeds the download, so one round-trip yields both.
function decodeTrades(b64: string): ExportTrade[] {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const arr = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Parse the human "1d 2h 3m 4s" string back to ms; null for "unknown".
function parseHeldMs(s: string): number | null {
  if (!s || s === "unknown") return null;
  const re = /(\d+)\s*([dhms])/g;
  let m: RegExpExecArray | null;
  let ms = 0;
  let found = false;
  while ((m = re.exec(s))) {
    found = true;
    const v = Number(m[1]);
    ms += m[2] === "d" ? v * 86400000 : m[2] === "h" ? v * 3600000 : m[2] === "m" ? v * 60000 : v * 1000;
  }
  return found ? ms : null;
}

function fmtHold(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function computeStats(trades: ExportTrade[]): HistoryStats {
  const exits = { TP: 0, SL: 0, "stop-out": 0, market: 0 };
  const sym = new Map<string, { count: number; net: number }>();
  let net = 0, wins = 0, losses = 0, holdSum = 0, holdN = 0;

  for (const t of trades) {
    net += t.netUsd;
    if (t.netUsd > 0) wins++;
    else if (t.netUsd < 0) losses++;
    const ms = parseHeldMs(t.timeHeld);
    if (ms != null) { holdSum += ms; holdN++; }
    if (t.closedBy === "TP" || t.closedBy === "SL" || t.closedBy === "stop-out") exits[t.closedBy]++;
    else exits.market++;
    const s = sym.get(t.symbol) ?? { count: 0, net: 0 };
    s.count++;
    s.net += t.netUsd;
    sym.set(t.symbol, s);
  }

  const bySymbol = [...sym.entries()]
    .map(([symbol, v]) => ({ symbol, ...v }))
    .sort((a, b) => b.count - a.count);

  return { count: trades.length, net, wins, losses, avgHoldMs: holdN ? holdSum / holdN : null, exits, bySymbol };
}

// Trade history: pick a from/to date (both default to today), load the closed
// trades for that range, and show performance stats computed from them. The same
// fetched data downloads as JSON, so nothing is re-requested. Native date inputs
// give mobile the OS calendar; the range is inclusive and interpreted in UTC.
function TradeHistorySection() {
  const today = todayUTC();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [doc, setDoc] = useState<CommandDocument | null>(null);

  const rangeError = from > to ? "The start date must be on or before the end date." : null;

  async function load() {
    if (rangeError) return;
    setBusy(true);
    setMsg(null);
    setStats(null);
    setDoc(null);
    try {
      const res = await api.exportTrades(from, to);
      if (res.document?.data) {
        setStats(computeStats(decodeTrades(res.document.data)));
        setDoc(res.document);
        notify("success");
      } else {
        // No document means no closed trades in range (the agent replies text).
        notify("warning");
        setMsg({ tone: "danger", text: res.text || "No closed trades in that range." });
      }
    } catch (e: any) {
      notify("error");
      setMsg({ tone: "danger", text: e?.message || "Could not load history" });
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!doc) return;
    const ok = downloadBase64(doc);
    notify(ok ? "success" : "warning");
    if (!ok) setMsg({ tone: "danger", text: "Your browser blocked the download. Use /export in the chat instead." });
  }

  const dateInput =
    "w-full rounded-md border border-hairline bg-surface px-3 py-2 text-sm tabular-nums text-fg " +
    "focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40 " +
    "[color-scheme:dark]";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-2 block text-sm font-medium text-fg-muted">From</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-fg-muted">To</label>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={dateInput} />
        </div>
      </div>

      {rangeError && <Flash tone="danger">{rangeError}</Flash>}
      {msg && <Flash tone={msg.tone}>{msg.text}</Flash>}

      <Button
        size="md"
        variant="primary"
        className="w-full"
        icon={<BarChart3 className="h-4 w-4" />}
        disabled={busy || !!rangeError}
        onClickAsync={rangeError ? undefined : load}
      >
        {busy ? "Loading…" : "Load stats"}
      </Button>

      {stats && <StatsView stats={stats} onDownload={download} />}
    </div>
  );
}

// Read-only performance summary for a loaded date range. Figures use the theme's
// status colours (green profit / red loss) and always carry a sign or label, so
// meaning never rests on colour alone.
function StatsView({ stats, onDownload }: { stats: HistoryStats; onDownload: () => void }) {
  const decided = stats.wins + stats.losses; // exclude break-even trades from the rate
  const winPct = decided ? (stats.wins / decided) * 100 : 0;

  return (
    <div className="space-y-5 border-t border-hairline pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Net P&L" value={pnl(stats.net)} tone={stats.net >= 0 ? "success" : "danger"} />
        <Tile label="Trades" value={String(stats.count)} />
        <Tile label="Win rate" value={decided ? `${winPct.toFixed(0)}%` : "—"} />
        <Tile label="Avg hold" value={stats.avgHoldMs != null ? fmtHold(stats.avgHoldMs) : "—"} />
      </div>

      {decided > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-fg-muted">
            <span>{stats.wins} win{stats.wins !== 1 ? "s" : ""}</span>
            <span>{stats.losses} loss{stats.losses !== 1 ? "es" : ""}</span>
          </div>
          {/* Win/loss proportion. 2px gap between the two fills per the mark spec. */}
          <div className="flex h-1.5 gap-0.5">
            <div className="rounded-full bg-success" style={{ width: `${winPct}%` }} />
            <div className="flex-1 rounded-full bg-danger" />
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-medium text-fg-muted">How trades closed</div>
        <div className="flex flex-wrap gap-2">
          <ExitChip label="TP" n={stats.exits.TP} tone="success" />
          <ExitChip label="SL" n={stats.exits.SL} tone="danger" />
          <ExitChip label="Stop-out" n={stats.exits["stop-out"]} tone="danger" />
          <ExitChip label="Market" n={stats.exits.market} tone="muted" />
        </div>
      </div>

      {stats.bySymbol.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-fg-muted">By symbol</div>
          <div className="space-y-1.5">
            {stats.bySymbol.map((s) => (
              <div key={s.symbol} className="flex items-center justify-between text-sm">
                <span className="font-medium text-fg">{s.symbol}</span>
                <span className="flex items-center gap-3 tabular-nums">
                  <span className="text-xs text-fg-faint">{s.count} trade{s.count !== 1 ? "s" : ""}</span>
                  <span className={s.net >= 0 ? "text-success" : "text-danger"}>{pnl(s.net)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button size="md" variant="secondary" className="w-full" icon={<Download className="h-4 w-4" />} onClick={onDownload}>
        Download JSON
      </Button>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-fg";
  return (
    <div className="rounded-md border border-hairline bg-canvas/40 p-3">
      <div className="text-xs text-fg-faint">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${color}`}>{value}</div>
    </div>
  );
}

function ExitChip({ label, n, tone }: { label: string; n: number; tone: "success" | "danger" | "muted" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-fg-muted";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 py-1 text-xs">
      <span className={`font-medium ${color}`}>{label}</span>
      <span className="tabular-nums text-fg">{n}</span>
    </span>
  );
}
