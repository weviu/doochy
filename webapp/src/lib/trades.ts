import type { CommandDocument } from "./api";

// Shared closed-trade helpers, used by both the Settings history stats and the
// History page. Kept here (not in a component) so there is one definition of the
// export shape and its decoder.

// One closed trade as the /export command builds it (src/bot/commands/export.ts).
export interface ExportTrade {
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

// Today's date as YYYY-MM-DD in UTC, matching the export command's own day
// boundaries (it treats the range in UTC).
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// Decode the base64 JSON the export command returns into the trades array. The
// same document also feeds the download, so one round-trip yields both.
export function decodeTrades(b64: string): ExportTrade[] {
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

// Trigger a browser download of a base64 file. Returns false if the environment
// blocks it (some in-app webviews do), so the caller can fall back to a message.
export function downloadBase64(doc: CommandDocument): boolean {
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
