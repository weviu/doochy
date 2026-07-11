// News-calendar guard: scheduled-news protection for in-scope instruments (gold
// today). Entry blackout + pre-news flatten around USD/High economic releases.
//
//   refresh()               - refetch + cache the calendar (from the pluggable source)
//   upcomingInScope(now)     - next in-scope events (dry-run / status)
//   inEntryBlackout(now,sym) - block a new entry near an event (or fail-closed on stale data)
//   shouldFlatten(now,sym)   - is an in-scope symbol inside its pre-news flatten window
//   startNewsMonitor()       - boot the refresh loop + pre-news flatten tick
export {
  refresh,
  upcomingInScope,
  inEntryBlackout,
  shouldFlatten,
  markFlattened,
  isFlattened,
  symbolInScope,
  entryInScope,
  isStale,
  cacheStatus,
  setSource,
  _resetForTest,
} from "./calendar";
export { startNewsMonitor } from "./monitor";
export { getNewsConfig, loadNewsConfig, setNewsConfig, DEFAULT_NEWS_CONFIG } from "./config";
export * from "./types";
export { ForexFactorySource, parseFFItem } from "./source";
