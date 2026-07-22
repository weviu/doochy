import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { haptic } from "../lib/telegram";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 " +
  "focus-visible:ring-offset-canvas disabled:opacity-50 disabled:pointer-events-none select-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-surface border border-hairline text-fg hover:bg-surface-hover hover:border-hairline-strong",
  ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
  danger: "text-danger hover:bg-danger-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  // When set, the button shows a spinner + disabled state for >=400ms so a fast
  // async action never flickers.
  onClickAsync?: () => Promise<void>;
  // A leading icon rendered in a single fixed slot that becomes the spinner
  // while loading (so the button never grows a second icon / changes width).
  // Prefer this over putting an icon in children when the button can be busy.
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  onClickAsync,
  onClick,
  className = "",
  children,
  disabled,
  icon,
  ...rest
}: ButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handle(e: React.MouseEvent<HTMLButtonElement>) {
    haptic("light");
    if (onClickAsync) {
      setLoading(true);
      const started = Date.now();
      try {
        await onClickAsync();
      } finally {
        const elapsed = Date.now() - started;
        if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
        setLoading(false);
      }
    } else {
      onClick?.(e);
    }
  }

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      onClick={handle}
      disabled={disabled || loading}
      {...rest}
    >
      {/* One fixed leading slot: the icon becomes the spinner while loading, so
          the button keeps its width instead of growing a second icon. When no
          `icon` is given, a bare spinner still prepends (legacy behaviour). */}
      {icon !== undefined
        ? (loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon)
        : loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({
  children,
  className = "",
  interactive = false,
  flat = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  // Omit the box-shadow. Use for cards that reposition during an animation
  // (accordions): an outset shadow repaints on every frame a card moves, which
  // stutters on mobile. The hairline border alone delineates the card here.
  flat?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border border-hairline bg-surface " +
        (flat ? "" : "shadow-card ") +
        (interactive ? "transition hover:bg-surface-hover hover:border-hairline-strong cursor-pointer " : "") +
        className
      }
    >
      {children}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-hover ${className}`} />;
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "success" | "danger" | "accent";
}) {
  const tones: Record<string, string> = {
    muted: "border-hairline bg-surface text-fg-muted",
    success: "border-success/30 bg-success-soft text-success",
    danger: "border-danger/30 bg-danger-soft text-danger",
    accent: "border-accent/20 bg-accent-soft text-accent",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

// A labelled numeric setting with an inline Save that only enables when the
// value has actually changed. On save it runs the async commit (which relays
// the command and returns fresh settings); the ">=400ms loading floor lives in
// Button so a fast round-trip never flickers. `value` is the authoritative
// current setting; local edits reset to it whenever it changes upstream.
export function NumberField({
  label,
  help,
  value,
  suffix,
  min,
  max,
  step = 1,
  onSave,
}: {
  label: string;
  help?: string;
  value: number;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  onSave: (next: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) &&
    (min === undefined || parsed >= min) && (max === undefined || parsed <= max);
  const changed = valid && parsed !== value;

  return (
    <div>
      <div className="mb-2">
        <label className="text-sm font-medium text-fg-muted">{label}</label>
        {help && <p className="mt-0.5 text-xs text-fg-faint">{help}</p>}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="number"
            inputMode="decimal"
            value={draft}
            min={min}
            max={max}
            step={step}
            onChange={(e) => setDraft(e.target.value)}
            className={
              "w-full rounded-md border bg-surface px-3 py-2 text-sm tabular-nums text-fg " +
              "placeholder:text-fg-faint focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/40 " +
              (valid ? "border-hairline" : "border-danger/50") +
              (suffix ? " pr-8" : "")
            }
          />
          {suffix && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-faint">
              {suffix}
            </span>
          )}
        </div>
        <Button
          size="md"
          variant={changed ? "primary" : "secondary"}
          disabled={!changed}
          onClickAsync={changed ? () => onSave(parsed) : undefined}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// A boolean setting rendered as a switch. The whole row is the hit target; the
// async commit shows a small spinner in place of the knob transition.
export function Toggle({
  label,
  help,
  checked,
  onToggle,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    haptic("light");
    setBusy(true);
    const started = Date.now();
    try {
      await onToggle(!checked);
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={flip}
      disabled={busy}
      className="flex w-full items-center justify-between gap-3 text-left disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg-muted">{label}</span>
        {help && <span className="mt-0.5 block text-xs text-fg-faint">{help}</span>}
      </span>
      <span
        className={
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition " +
          (checked ? "bg-accent" : "bg-surface-active")
        }
      >
        <span
          className={
            "inline-flex h-4 w-4 items-center justify-center rounded-full bg-white transition " +
            (checked ? "translate-x-4" : "translate-x-0.5")
          }
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
        </span>
      </span>
    </button>
  );
}

// A height collapse animated by interpolating a CSS grid row (0fr -> 1fr) plus
// an opacity fade. Both are compositor-friendly, unlike animating height:auto
// (which forces a full reflow every frame and stutters on mobile). The child is
// overflow-hidden, which is what lets the 0fr track shrink it fully. Content
// stays mounted while collapsed, so no remount cost on toggle. The global
// prefers-reduced-motion rule in index.css shortens the transition to ~instant.
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className={"overflow-hidden transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")}>
        {children}
      </div>
    </div>
  );
}

// A collapsible settings section. Collapsed by default; the header toggles it.
// The open/close glides via Collapse (CSS grid, not JS height). Purely a layout
// container for a group of controls.
export function SectionCard({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card flat className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-surface-hover"
      >
        <span>
          <span className="block text-sm font-semibold text-fg">{title}</span>
          {description && <span className="mt-0.5 block text-xs text-fg-faint">{description}</span>}
        </span>
        <ChevronDown className={"h-4 w-4 shrink-0 text-fg-muted transition duration-300 " + (open ? "rotate-180" : "")} />
      </button>
      <Collapse open={open}>
        <div className="space-y-5 border-t border-hairline px-5 py-5">{children}</div>
      </Collapse>
    </Card>
  );
}

// A save-state flash used after a command relay: shows the agent's reply text
// briefly, tinted by success/error. Auto-clears after a few seconds.
export function Flash({ tone, children }: { tone: "success" | "danger"; children: ReactNode }) {
  const cls = tone === "success"
    ? "border-success/30 bg-success-soft text-success"
    : "border-danger/30 bg-danger-soft text-danger";
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${cls}`}>
      {tone === "success" && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// Selectable/removable symbol chip. In "remove" mode the whole chip is a button
// that removes the symbol; a plain chip is display-only.
export function Chip({
  children,
  onRemove,
}: {
  children: ReactNode;
  onRemove?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!onRemove) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-xs font-medium text-fg-muted">
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        haptic("light");
        setBusy(true);
        try { await onRemove(); } finally { setBusy(false); }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-xs font-medium text-fg-muted transition hover:border-danger/40 hover:text-danger disabled:opacity-50"
    >
      {children}
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="text-fg-faint">×</span>}
    </button>
  );
}
