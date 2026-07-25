export function money(n: number, currency = "USD"): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}${currency && currency !== "USD" ? ` ${currency}` : ""}`;
}

// Signed money for P&L, so positive values carry a leading +.
export function pnl(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

export function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// A price to at most 3 decimals, trailing zeros trimmed: 4046.873333 -> "4046.873",
// 58.81 -> "58.81", 57902 -> "57902". Null/undefined render as an em dash.
export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Number(n.toFixed(3)));
}
