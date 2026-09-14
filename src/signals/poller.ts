import { parseSignal } from "./parser";
import { ParsedSignal } from "./types";

// The signal generator (the crypto-scanner project) runs centrally and serves its
// feed over HTTP; every agent polls that URL. Agents don't have the scanner in
// their own repo (it's private/git-ignored), so a local disk read would never work
// for them — the feed is always fetched. Override with SCANNER_FEED_URL.
const FEED_URL = process.env.SCANNER_FEED_URL || "https://doochy.route07.com/alerts.json";

const INTERVAL_MS = 10_000;

let lastTimestamp: string | null = null;

// Fetch + parse the feed. Returns [] (warning only) on any network/parse error, so
// a transient feed outage never crashes the agent — the next tick retries.
export async function fetchFeed(): Promise<any[]> {
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    console.warn(`[POLLER] Fetch failed: ${err.message}${cause !== err.message ? ` (${cause})` : ""}`);
    return [];
  }
}

export function startPoller(onSignal: (signal: ParsedSignal) => void): void {
  console.log(`[POLLER] Starting. Feed: ${FEED_URL}`);

  const poll = async () => {
    const alerts = await fetchFeed();
    if (alerts.length === 0) return;

    if (!lastTimestamp) {
      // First fetch — store the latest timestamp, don't process the backlog.
      lastTimestamp = alerts[0].timestamp;
      console.log(`[POLLER] Connected. ${alerts.length} alerts in feed. Last: ${lastTimestamp}`);
      return;
    }

    // Feed is newest-first; take everything newer than what we last saw.
    const newAlerts = alerts.filter((a) => a.timestamp > lastTimestamp!);
    if (newAlerts.length === 0) return;

    console.log(`[POLLER] ${newAlerts.length} new signal(s)`);

    // Process oldest first.
    for (const alert of newAlerts.reverse()) {
      const signal = parseSignal(alert);
      if (signal) {
        console.log(`[POLLER] → ${signal.direction} ${signal.symbol} | RSI: ${signal.rsi} | Confidence: ${signal.confidence}`);
        onSignal(signal);
      }
    }

    lastTimestamp = newAlerts[newAlerts.length - 1].timestamp;
  };

  poll(); // Run immediately
  setInterval(poll, INTERVAL_MS);
}
