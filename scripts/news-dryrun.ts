import { refresh, upcomingInScope, getNewsConfig, loadNewsConfig, cacheStatus, isStale } from "../src/risk/news";

// Dry-run: fetch the current live calendar and print the next in-scope events (UTC)
// with their computed entry-blackout and pre-news flatten windows. No trading, no
// broker connection. Run with: pnpm news:dryrun  (tsx scripts/news-dryrun.ts)

const MIN = 60_000;
function fmt(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z").replace("T", " ");
}

async function main() {
  loadNewsConfig();
  const cfg = getNewsConfig();
  console.log("News config:");
  console.log(`  scope:      symbols=${JSON.stringify(cfg.symbols)} sources=${JSON.stringify(cfg.sources)}`);
  console.log(`  events:     currencies=${JSON.stringify(cfg.currencies)} impact=${JSON.stringify(cfg.impactLevels)}`);
  console.log(`  windows:    pre=${cfg.preBlackoutMin}m post=${cfg.postBlackoutMin}m flattenLead=${cfg.flattenLeadMin}m`);
  console.log(`  staleness:  maxStaleHours=${cfg.maxStaleHours} failClosed=${cfg.failClosed} includeTentativeAsAllDay=${cfg.includeTentativeAsAllDay}`);
  console.log("");

  console.log("Fetching calendar...");
  const res = await refresh();
  const status = cacheStatus();
  console.log(`  ${res.ok ? "OK" : "FAILED (" + res.error + ", using cache)"} - ${status.count} events cached, fetched ${status.fetchedAt ? fmt(status.fetchedAt) : "never"}, stale=${isStale(Date.now())}`);
  console.log("");

  const now = Date.now();
  const up = upcomingInScope(now).slice(0, 5);
  if (up.length === 0) {
    console.log("No upcoming in-scope events found.");
    return;
  }

  console.log(`Next ${up.length} in-scope events (all times UTC):`);
  for (const ev of up) {
    if (ev.allDay || ev.time == null) {
      console.log(`\n  ${ev.title}  [${ev.currency}/${ev.impact}]`);
      console.log(`    ALL-DAY / tentative on ${ev.dateStr}`);
      console.log(`    entry blackout: all of ${ev.dateStr} (UTC)`);
      console.log(`    flatten:        none (no reliable time)`);
    } else {
      const t = ev.time;
      console.log(`\n  ${ev.title}  [${ev.currency}/${ev.impact}]`);
      console.log(`    event:          ${fmt(t)}`);
      console.log(`    entry blackout: ${fmt(t - cfg.preBlackoutMin * MIN)}  ..  ${fmt(t + cfg.postBlackoutMin * MIN)}`);
      console.log(`    flatten window: ${fmt(t - cfg.flattenLeadMin * MIN)}  ..  ${fmt(t + cfg.postBlackoutMin * MIN)}`);
    }
  }
}

main().catch((err) => {
  console.error("Dry-run error:", err);
  process.exit(1);
});
