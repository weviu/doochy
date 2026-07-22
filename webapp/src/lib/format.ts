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
