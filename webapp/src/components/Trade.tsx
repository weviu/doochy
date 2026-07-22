import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { api, type OrderPreview, type Quote } from "../lib/api";
import { notify } from "../lib/telegram";
import { money } from "../lib/format";
import { Button, Card, Flash, Skeleton } from "./ui";
import { FadeRise } from "./motion";
import { ConfirmModal } from "./Modal";

// Manual order panel. Restrained-CEX: the live price is the focal point and the
// BUY/SELL toggle is the one place saturated green/red earns its keep; the rest
// stays on the Dark Notion palette.
//
// Sizing has two modes and one authority: whichever mode you're in, the agent's
// order_preview endpoint computes the final lots/risk with the same code that
// sizes the real order, so what's on screen is what gets placed. Nothing is
// arithmetic'd in the browser.

type Direction = "BUY" | "SELL";
type OrderType = "MARKET" | "LIMIT";
type Mode = "size" | "risk";

const QUOTE_POLL_MS = 2000;
const PREVIEW_DEBOUNCE_MS = 300;
const MODE_KEY = "doochy.trade.mode";

function num(s: string): number | null {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

export function Trade() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [symbol, setSymbol] = useState<string>("");
  const [direction, setDirection] = useState<Direction>("BUY");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  // Remember the user's preferred sizing mode across sessions.
  const [mode, setMode] = useState<Mode>(() =>
    (localStorage.getItem(MODE_KEY) as Mode) === "risk" ? "risk" : "size"
  );

  const [entry, setEntry] = useState("");
  const [lots, setLots] = useState("");
  const [risk, setRisk] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");

  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  // Poll live prices. Only allowed symbols come back, which is exactly the set
  // an order would be accepted for.
  const loadQuotes = useCallback(async () => {
    try {
      const d = await api.quotes();
      setQuotes(d.quotes);
      setSymbol((cur) => cur || d.quotes.find((q) => q.tradable)?.symbol || d.quotes[0]?.symbol || "");
    } catch {
      setQuotes((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    loadQuotes();
    const t = setInterval(loadQuotes, QUOTE_POLL_MS);
    return () => {
      clearInterval(t);
      if (debounce.current) clearTimeout(debounce.current);
      if (resultTimer.current) clearTimeout(resultTimer.current);
    };
  }, [loadQuotes]);

  const q = quotes?.find((x) => x.symbol === symbol) ?? null;
  // Mirrors getMarkPrice: a BUY is valued off the bid, a SELL off the ask.
  const mark = q ? (direction === "BUY" ? q.bid : q.ask) : null;
  const spread = q?.bid != null && q?.ask != null ? q.ask - q.bid : null;

  const sizeInput = mode === "size" ? num(lots) : num(risk);
  const slNum = num(sl);
  const tpNum = num(tp);
  const entryNum = num(entry);

  // Client-side side validation, purely for instant feedback. The agent's order
  // handler is the authority and re-checks this before anything is placed.
  const ref = orderType === "LIMIT" ? entryNum : mark;
  let sideErr: string | null = null;
  if (ref != null && tpNum != null && slNum != null) {
    if (direction === "BUY") {
      if (tpNum <= ref) sideErr = "For a BUY, take profit must be above the entry.";
      else if (slNum >= ref) sideErr = "For a BUY, stop loss must be below the entry.";
    } else {
      if (tpNum >= ref) sideErr = "For a SELL, take profit must be below the entry.";
      else if (slNum <= ref) sideErr = "For a SELL, stop loss must be above the entry.";
    }
  }

  const ready = !!symbol && sizeInput != null && slNum != null && tpNum != null &&
    (orderType === "MARKET" || entryNum != null) && !sideErr;

  // Debounced preview: the agent computes lots/risk/reward, we just render it.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!ready) { setPreview(null); setPreviewErr(null); return; }
    setPreviewing(true);
    debounce.current = setTimeout(async () => {
      try {
        const p = await api.orderPreview({
          symbol, direction, orderType,
          entry: orderType === "LIMIT" ? entryNum : null,
          sl: slNum, tp: tpNum, mode,
          lots: mode === "size" ? sizeInput : null,
          riskUSD: mode === "risk" ? sizeInput : null,
        });
        setPreview(p);
        setPreviewErr(null);
      } catch (e: any) {
        setPreview(null);
        setPreviewErr(e?.message || "Could not price this order");
      } finally {
        setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, direction, orderType, mode, sizeInput, slNum, tpNum, entryNum, ready]);

  function showResult(tone: "success" | "danger", text: string) {
    setResult({ tone, text });
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), 8000);
  }

  // Place the order with the lots the preview settled on, so what was confirmed
  // is what is sent (in risk mode the user never typed a lot size at all).
  async function place() {
    const finalLots = preview?.lots;
    if (!finalLots || !tpNum || !slNum) return;
    const args = orderType === "LIMIT" && entryNum
      ? [direction, symbol, String(finalLots), String(entryNum), String(tpNum), String(slNum)]
      : [direction, symbol, String(finalLots), String(tpNum), String(slNum)];
    try {
      const res = await api.placeOrder(args);
      const failed = /not placed|failed|cannot|not in your allowed|not available/i.test(res.text);
      notify(failed ? "error" : "success");
      showResult(failed ? "danger" : "success", res.text);
      if (!failed) { setLots(""); setRisk(""); setTp(""); setSl(""); setEntry(""); setPreview(null); }
    } catch (e: any) {
      notify("error");
      showResult("danger", e?.message || "Order failed");
    }
  }

  if (!quotes) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (quotes.length === 0) {
    return (
      <FadeRise>
        <Card className="p-8 text-center">
          <div className="text-sm text-fg-muted">No symbols configured.</div>
          <div className="mt-1 text-xs text-fg-faint">Add one in Settings before trading.</div>
        </Card>
      </FadeRise>
    );
  }

  return (
    <div className="space-y-4">
      {result && <FadeRise><Flash tone={result.tone}>{result.text}</Flash></FadeRise>}

      {/* ---- Symbol + live price ------------------------------------------- */}
      <FadeRise>
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="relative">
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="appearance-none rounded-md border border-hairline bg-surface py-1.5 pl-3 pr-8 text-sm font-semibold tracking-tight text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                {quotes.map((x) => (
                  <option key={x.symbol} value={x.symbol} disabled={!x.tradable}>
                    {x.symbol}{x.tradable ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold tabular-nums tracking-tight">
                {mark != null ? mark : <span className="text-fg-faint">—</span>}
              </div>
              <div className="mt-0.5 text-xs tabular-nums text-fg-faint">
                {q?.bid != null && q?.ask != null
                  ? <>bid {q.bid} · ask {q.ask}{spread != null ? ` · spread ${spread.toFixed(2)}` : ""}</>
                  : "waiting for a quote"}
              </div>
            </div>
          </div>
        </Card>
      </FadeRise>

      {/* ---- Ticket -------------------------------------------------------- */}
      <FadeRise delay={0.05}>
        <Card className="space-y-4 p-5">
          {/* Direction: the one place saturated green/red is warranted. */}
          <div className="grid grid-cols-2 gap-2">
            {(["BUY", "SELL"] as Direction[]).map((d) => {
              const on = direction === d;
              const tone = d === "BUY"
                ? (on ? "border-success bg-success-soft text-success" : "border-hairline bg-surface text-fg-muted hover:text-fg")
                : (on ? "border-danger bg-danger-soft text-danger" : "border-hairline bg-surface text-fg-muted hover:text-fg");
              return (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`h-10 rounded-md border text-sm font-semibold transition ${tone}`}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {/* Order type */}
          <div className="flex gap-1">
            {(["MARKET", "LIMIT"] as OrderType[]).map((t) => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                className={
                  "rounded-md px-3 py-1.5 text-xs font-medium capitalize transition " +
                  (orderType === t
                    ? "border border-accent/20 bg-accent-soft text-accent"
                    : "border border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg")
                }
              >
                {t.toLowerCase()}
              </button>
            ))}
          </div>

          {orderType === "LIMIT" && (
            <Field label="Entry price" value={entry} onChange={setEntry} placeholder={mark != null ? String(mark) : "0.00"} />
          )}

          {/* Size ⇄ Risk switch */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-fg-muted">
                {mode === "size" ? "Size" : "Risk"}
              </span>
              <div className="flex gap-1">
                {(["size", "risk"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={
                      "rounded-md px-2 py-1 text-xs font-medium capitalize transition " +
                      (mode === m
                        ? "border border-accent/20 bg-accent-soft text-accent"
                        : "border border-transparent text-fg-faint hover:text-fg")
                    }
                  >
                    {m === "size" ? "by size" : "by risk"}
                  </button>
                ))}
              </div>
            </div>
            {mode === "size" ? (
              <BareField value={lots} onChange={setLots} placeholder="0.02" suffix="lots" />
            ) : (
              <BareField value={risk} onChange={setRisk} placeholder="50" suffix="$" />
            )}
            <p className="mt-1 text-xs text-fg-faint">
              {mode === "size"
                ? q?.minLots != null ? `Min ${q.minLots} lots, step ${q.lotStep ?? "-"}.` : "Lots to trade."
                : "The bot sizes the position so a stop-out loses about this."}
            </p>
          </div>

          <Field label="Take profit" value={tp} onChange={setTp} placeholder="0.00" />
          <Field label="Stop loss" value={sl} onChange={setSl} placeholder="0.00" />

          {sideErr && <Flash tone="danger">{sideErr}</Flash>}
          {previewErr && !sideErr && <Flash tone="danger">{previewErr}</Flash>}

          {/* ---- Risk preview: always visible before placing --------------- */}
          {preview && !sideErr && (
            <div className="rounded-md border border-hairline bg-canvas/60 p-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric label="If SL hits" value={preview.riskUSD != null ? `-${money(preview.riskUSD)}` : "—"} tone="danger" />
                <Metric label="At TP" value={preview.rewardUSD != null ? `+${money(preview.rewardUSD)}` : "—"} tone="success" />
                <Metric label="R:R" value={preview.rr != null ? `1:${preview.rr.toFixed(2)}` : "—"} />
              </div>
              <div className="mt-3 border-t border-hairline pt-2 text-center text-xs tabular-nums text-fg-muted">
                {mode === "risk"
                  ? <>Size: <span className="font-semibold text-fg">{preview.lots} lots</span></>
                  : <>Risking <span className="font-semibold text-fg">{preview.riskUSD != null ? money(preview.riskUSD) : "—"}</span> on {preview.lots} lots</>}
                {preview.snapped && <span className="text-fg-faint"> · adjusted to the broker's size grid</span>}
              </div>
              {preview.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-fg-faint">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button
            size="lg"
            variant="primary"
            className="w-full"
            disabled={!ready || !preview || previewing}
            onClick={() => setConfirm(true)}
          >
            {previewing ? "Pricing…" : `Place ${direction.toLowerCase()} order`}
          </Button>
        </Card>
      </FadeRise>

      <ConfirmModal
        open={confirm}
        title={`${direction} ${symbol}?`}
        body={
          <span>
            {orderType === "LIMIT" ? `Limit order at ${entryNum}` : "Market order at the live price"} for{" "}
            <strong className="text-fg">{preview?.lots} lots</strong>, TP {tpNum}, SL {slNum}.
            {preview?.riskUSD != null && (
              <> You lose about <strong className="text-danger">{money(preview.riskUSD)}</strong> if the stop is hit.</>
            )}
            <br /><br />
            <span className="text-fg-faint">
              Manual orders skip your cooldowns, max positions and daily limits.
            </span>
          </span>
        }
        confirmLabel={`${direction} ${preview?.lots ?? ""} lots`}
        danger={direction === "SELL"}
        onConfirm={place}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-fg";
  return (
    <div>
      <div className="text-xs text-fg-faint">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function BareField({
  value, onChange, placeholder, suffix,
}: { value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string }) {
  return (
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={
          "w-full rounded-md border border-hairline bg-surface px-3 py-2 text-sm tabular-nums text-fg " +
          "placeholder:text-fg-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/40 " +
          (suffix ? "pr-10" : "")
        }
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-faint">
          {suffix}
        </span>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-fg-muted">{label}</label>
      <BareField value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  );
}
