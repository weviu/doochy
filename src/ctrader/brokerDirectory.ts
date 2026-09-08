// Account directory from the cTrader REST API (api.spotware.com/connect/
// tradingaccounts): the one call that maps the internal ctidTraderAccountId the
// bot trades with to the broker name and login (accountNumber) a user actually
// sees in their platform. Purely for DISPLAY — /status, /positions and the
// setup wizard label accounts as "48001768 Instant Funding (3064718)" instead
// of a bare number. Cosmetic and strictly non-fatal: when the directory is
// unavailable the display falls back to the bare ctid exactly as before.

export interface BrokerDirectoryEntry {
  // Internal ctidTraderAccountId — what the bot and .env use.
  accountId: number;
  // The login the user types into the platform (cTrader's traderLogin).
  accountNumber: number;
  live: boolean;
  brokerName: string;
  brokerTitle: string | null;
}

const directory = new Map<number, BrokerDirectoryEntry>();
let fetching: Promise<Map<number, BrokerDirectoryEntry>> | null = null;

// GET the full account list for an access token. The response is app-scoped
// (same list on demo and live hosts), so ONE call covers every configured
// account, whatever environment it trades on.
export async function fetchBrokerDirectory(
  accessToken: string
): Promise<Map<number, BrokerDirectoryEntry>> {
  const url =
    `https://api.spotware.com/connect/tradingaccounts` +
    `?access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`tradingaccounts API: HTTP ${res.status}`);
  const body: any = await res.json();
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  directory.clear();
  for (const e of data) {
    const accountId = Number(e.accountId);
    if (!Number.isFinite(accountId) || !String(e.brokerName || "")) continue;
    directory.set(accountId, {
      accountId,
      accountNumber: Number(e.accountNumber) || 0,
      live: e.live === true || e.live === "true",
      brokerName: String(e.brokerName),
      brokerTitle: e.brokerTitle ? String(e.brokerTitle) : null,
    });
  }
  return directory;
}

// Kick the directory fetch off once, in the background. Never blocks or throws
// for callers: the outcome is cosmetic, so a slow or failing REST call must not
// delay boot or fail it.
export function ensureBrokerDirectory(accessToken: string): void {
  if (directory.size > 0 || fetching) return;
  fetching = fetchBrokerDirectory(accessToken).catch((err: any) => {
    console.warn(
      `[DIRECTORY] Broker name/login lookup failed (${err?.message || err}); /status and /positions show bare account ids`
    );
    return directory;
  });
}

export function brokerInfoFor(ctid: number): BrokerDirectoryEntry | null {
  return directory.get(ctid) ?? null;
}

// Display label for an account: "5043626 Leveraged", or null when the directory
// has not loaded yet (callers then show the bare ctid). The login is the id a
// user actually recognizes from their platform; the internal ctid is a bot
// detail, so the label leads with the login when known.
export function accountLabel(ctid: number): string | null {
  const e = directory.get(ctid);
  if (!e) return null;
  const broker = e.brokerTitle || e.brokerName;
  const id = e.accountNumber || e.accountId;
  return `${id} ${broker}`;
}