import { InputFile } from "grammy";
import { state } from "../../state";
import { getSymbolSpec } from "../../ctrader/orders";

let connection: any = null;

export function setExportConnection(conn: any): void {
  connection = conn;
}

// cTrader limits ProtoOADealListReq to a 7-day window per request.
const WEEK_MS = 604_800_000;

function symbolName(symbolId: number): string {
  const target = String(symbolId);
  for (const [name, id] of state.symbolMap.entries()) {
    if (String(id) === target) return name;
  }
  return `#${symbolId}`;
}

// Parse "YYYY-MM-DD" or "YYYY-MM-DD_HH:MM" as a UTC epoch ms. When no time is
// given, a `from` date snaps to 00:00 and a `to` date snaps to 23:59:59.
function parseDateArg(s: string, endOfDay: boolean): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const hasTime = hh !== undefined;
  return Date.UTC(
    +y, +mo - 1, +d,
    hasTime ? +hh : endOfDay ? 23 : 0,
    hasTime ? +mm : endOfDay ? 59 : 0,
    hasTime ? 0 : endOfDay ? 59 : 0
  );
}

export async function exportCmd(ctx: any) {
  if (!connection) {
    await ctx.reply("No cTrader connection.");
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const now = Date.now();
  let from: number;
  let to: number;

  if (parts.length === 1) {
    from = now - 7 * 24 * 3600 * 1000;
    to = now;
  } else {
    const f = parseDateArg(parts[1], false);
    if (f === null) {
      await ctx.reply("Bad 'from' date. Use 2026-06-01 or 2026-06-01_12:30");
      return;
    }
    from = f;
    if (parts[2]) {
      const t = parseDateArg(parts[2], true);
      if (t === null) {
        await ctx.reply("Bad 'to' date. Use 2026-06-05 or 2026-06-05_23:59");
        return;
      }
      to = t;
    } else {
      to = now;
    }
  }

  if (from >= to) {
    await ctx.reply("'from' must be before 'to'.");
    return;
  }

  await ctx.reply("Fetching trade history…");

  // Pull deals in <=7-day chunks.
  const deals: any[] = [];
  try {
    for (let start = from; start < to; start += WEEK_MS) {
      const end = Math.min(start + WEEK_MS, to);
      const res = await connection.sendCommand("ProtoOADealListReq", {
        ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
        fromTimestamp: start,
        toTimestamp: end,
        maxRows: 1000,
      });
      deals.push(...(res.deal || []));
    }
  } catch (err: any) {
    await ctx.reply(`Failed to fetch history: ${err.errorCode || err.message || "request failed"}`);
    return;
  }

  // Also fetch orders so we can tell HOW each position closed. The closing deal
  // references its order via orderId; that order's type reveals SL/TP vs market.
  const orderById = new Map<string, any>();
  try {
    for (let start = from; start < to; start += WEEK_MS) {
      const end = Math.min(start + WEEK_MS, to);
      const res = await connection.sendCommand("ProtoOAOrderListReq", {
        ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
        fromTimestamp: start,
        toTimestamp: end,
      });
      for (const o of res.order || []) orderById.set(String(o.orderId), o);
    }
  } catch {
    // Non-fatal — we just won't be able to classify the exit reason.
  }

  // Earliest deal per position = its open time, used to compute time held.
  const openTsByPos = new Map<string, number>();
  for (const d of deals) {
    const pid = String(d.positionId);
    const ts = Number(d.executionTimestamp);
    const cur = openTsByPos.get(pid);
    if (cur === undefined || ts < cur) openTsByPos.set(pid, ts);
  }

  // Closing deals carry realized P&L (closePositionDetail). Opening deals don't.
  const closing = deals.filter((d) => d.closePositionDetail);
  if (closing.length === 0) {
    await ctx.reply("No closed trades in that range.");
    return;
  }
  closing.sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp));

  const trades: any[] = [];
  let totalNet = 0;

  for (const d of closing) {
    const cpd = d.closePositionDetail;
    const div = Math.pow(10, Number(cpd.moneyDigits ?? 2));
    const net = (Number(cpd.grossProfit || 0) + Number(cpd.swap || 0) + Number(cpd.commission || 0)) / div;
    totalNet += net;

    const symId = Number(d.symbolId);
    const spec = await getSymbolSpec(symId);
    const lots = spec?.lotSize ? Number(d.filledVolume) / spec.lotSize : Number(d.filledVolume);
    // The closing deal's side is the opposite of the original position.
    const origSide = d.tradeSide === "BUY" ? "SELL" : "BUY";

    const closeTs = Number(d.executionTimestamp);
    const openTs = openTsByPos.get(String(d.positionId));
    const heldMs = openTs !== undefined && openTs < closeTs ? closeTs - openTs : null;

    // Classify the exit using the closing order's type.
    const ord = orderById.get(String(d.orderId));
    let closedBy = "market"; // manual or market close
    if (ord) {
      if (ord.isStopOut) {
        closedBy = "stop-out";
      } else if (ord.orderType === "STOP_LOSS_TAKE_PROFIT") {
        const exitAboveEntry = Number(d.executionPrice) >= Number(cpd.entryPrice);
        const isTP = origSide === "BUY" ? exitAboveEntry : !exitAboveEntry;
        closedBy = isTP ? "TP" : "SL";
      }
    }

    trades.push({
      time: new Date(closeTs).toISOString().slice(0, 19).replace("T", " ") + " UTC",
      symbol: symbolName(symId),
      side: origSide,
      lots,
      entry: cpd.entryPrice ?? null,
      exit: d.executionPrice ?? null,
      netUsd: Number(net.toFixed(2)),
      timeHeld: heldMs === null ? "unknown" : formatDuration(heldMs),
      closedBy,
    });
  }

  const json = JSON.stringify(trades, null, 2);
  const fname = `trades_${new Date(from).toISOString().slice(0, 10)}_to_${new Date(to).toISOString().slice(0, 10)}.json`;
  const caption = `${trades.length} closed trade(s). Net: ${totalNet >= 0 ? "+" : ""}${totalNet.toFixed(2)} USD`;

  await ctx.replyWithDocument(new InputFile(Buffer.from(json, "utf-8"), fname), { caption });
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(" ");
}
