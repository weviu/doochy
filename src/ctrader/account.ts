import { state, AccountInfo } from "../state";
import { primaryAccountId } from "./accounts";

// Pull live trader data (balance) from the broker. Throws on failure so callers
// that want a health check can detect a dead connection.
export async function fetchTrader(connection: any): Promise<AccountInfo> {
  const res = await connection.sendCommand("ProtoOATraderReq", {
    ctidTraderAccountId: primaryAccountId(),
  });
  const t = res.trader;
  if (!t) throw new Error("No trader data in response");

  // Money fields are integers scaled by 10^moneyDigits.
  const div = Math.pow(10, Number(t.moneyDigits ?? 2));
  const balance = Number(t.balance || 0) / div;

  state.accountInfo = {
    balance,
    equity: balance, // equity needs unrealized P&L (live prices); use balance as a proxy
    currency: state.accountInfo.currency || "USD",
  };
  return state.accountInfo;
}

// Net realized P&L for closed deals since `fromMs`, read live from the broker.
// Authoritative seed for the daily loss/profit limits, since the in-memory
// counter resets on restart. Returns every deal id seen in the window so the
// risk engine can mark them counted — a close event arriving AFTER a seed that
// already included that deal must not be added a second time.
//
// Paginated: ProtoOADealListReq caps at 1000 rows per call and sets hasMore
// when the window holds more; the old single-call version silently truncated a
// busy day. Pages advance by the last execution timestamp seen; the dealIds set
// dedupes the boundary deal that appears in two consecutive pages.
export async function fetchRealizedPnLSince(
  connection: any,
  fromMs: number
): Promise<{ net: number; dealIds: Set<string> }> {
  const dealIds = new Set<string>();
  let net = 0;
  let from = fromMs;
  const to = Date.now();

  for (let page = 0; page < 20; page++) {
    const res = await connection.sendCommand("ProtoOADealListReq", {
      ctidTraderAccountId: primaryAccountId(),
      fromTimestamp: from,
      toTimestamp: to,
      maxRows: 1000,
    });

    const deals = res.deal || [];
    let lastTs = from;
    for (const d of deals) {
      const id = String(d.dealId ?? "");
      if (id) {
        if (dealIds.has(id)) continue; // page-boundary duplicate
        dealIds.add(id);
      }
      const ts = Number(d.executionTimestamp || 0);
      if (ts > lastTs) lastTs = ts;
      const cpd = d.closePositionDetail; // only closing deals carry realized P&L
      if (!cpd) continue;
      const div = Math.pow(10, Number(cpd.moneyDigits ?? 2));
      net += (Number(cpd.grossProfit || 0) + Number(cpd.swap || 0) + Number(cpd.commission || 0)) / div;
    }

    if (!res.hasMore) break;
    if (lastTs <= from) break; // no forward progress; avoid a hot loop
    from = lastTs;
  }

  return { net, dealIds };
}

// Boot-time fetch. Never throws — a failure here must not crash startup.
export async function fetchAccountInfo(connection: any): Promise<AccountInfo> {
  console.log(`[ACCOUNT] Account ID: ${primaryAccountId()}`);
  try {
    const info = await fetchTrader(connection);
    console.log(`[ACCOUNT] Balance: ${info.balance} ${info.currency}`);
  } catch (err: any) {
    console.warn(`[ACCOUNT] Could not fetch trader: ${err.errorCode || err.message || "request failed"}`);
  }
  return state.accountInfo;
}
