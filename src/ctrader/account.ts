import { runtimeFor, RuntimeState, AccountInfo } from "../state";

// Pull live trader data (balance) from the broker for ONE account. Throws on
// failure so callers that want a health check can detect a dead connection.
// The account is explicit: with several sessions on one connection, "the
// account" is whoever the caller is acting on. Writes the account's runtime
// accountInfo so display and sizing read the same cached figure.
export async function fetchTrader(connection: any, ctid: number): Promise<AccountInfo> {
  const res = await connection.sendCommand("ProtoOATraderReq", {
    ctidTraderAccountId: ctid,
  });
  const t = res.trader;
  if (!t) throw new Error("No trader data in response");

  // Money fields are integers scaled by 10^moneyDigits.
  const div = Math.pow(10, Number(t.moneyDigits ?? 2));
  const balance = Number(t.balance || 0) / div;

  const rt = runtimeFor(ctid);
  rt.accountInfo = {
    balance,
    equity: balance, // equity needs unrealized P&L (live prices); use balance as a proxy
    currency: rt.accountInfo.currency || "USD",
  };
  return rt.accountInfo;
}

// Net realized P&L for closed deals since `fromMs`, read live from the broker
// for ONE account. Authoritative seed for that account's daily loss/profit
// limits, since the in-memory counter resets on restart. Returns every deal id
// seen in the window so the risk engine can mark them counted — a close event
// arriving AFTER a seed that already included that deal must not be added a
// second time.
//
// Paginated: ProtoOADealListReq caps at 1000 rows per call and sets hasMore
// when the window holds more; the old single-call version silently truncated a
// busy day. Pages advance by the last execution timestamp seen; the dealIds set
// dedupes the boundary deal that appears in two consecutive pages.
export async function fetchRealizedPnLSince(
  connection: any,
  ctid: number,
  fromMs: number
): Promise<{ net: number; dealIds: Set<string> }> {
  const dealIds = new Set<string>();
  let net = 0;
  let from = fromMs;
  const to = Date.now();

  for (let page = 0; page < 20; page++) {
    const res = await connection.sendCommand("ProtoOADealListReq", {
      ctidTraderAccountId: ctid,
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

// Boot-time fetch for ONE account. Never throws — a failure here must not crash
// startup.
export async function fetchAccountInfo(connection: any, rt: RuntimeState): Promise<AccountInfo> {
  console.log(`[ACCOUNT] Account ID: ${rt.ctid}`);
  try {
    const info = await fetchTrader(connection, rt.ctid);
    console.log(`[ACCOUNT] Balance: ${info.balance} ${info.currency}`);
  } catch (err: any) {
    console.warn(`[ACCOUNT] Could not fetch trader for ${rt.ctid}: ${err.errorCode || err.message || "request failed"}`);
  }
  return rt.accountInfo;
}