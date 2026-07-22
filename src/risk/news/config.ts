import fs from "fs";
import path from "path";
import { NewsConfig } from "./types";

// Recommended defaults (see the task spec). Sensible for a $300/day prop account:
// a wide-enough entry blackout that a signal firing just before a release is held,
// and a flatten lead that gets us flat well before the print.
export const DEFAULT_NEWS_CONFIG: NewsConfig = {
  preBlackoutMin: 60,
  postBlackoutMin: 15,
  flattenLeadMin: 30,
  currencies: ["USD"],
  impactLevels: ["High"],
  symbols: ["XAUUSD"],
  sources: ["gold_scanner"],
  maxStaleHours: 12,
  failClosed: true,
  includeTentativeAsAllDay: true,
  refreshHours: 6,
};

const CONFIG_FILE = path.join(process.cwd(), "data", "news-config.json");

let current: NewsConfig = { ...DEFAULT_NEWS_CONFIG };

// Load overrides from data/news-config.json if present. Only known keys are
// applied (unknown keys ignored), so a partial file just tweaks a few knobs and
// leaves the rest at defaults. Never throws — a bad file logs and keeps defaults.
export function loadNewsConfig(): NewsConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const merged: NewsConfig = { ...DEFAULT_NEWS_CONFIG };
      for (const key of Object.keys(DEFAULT_NEWS_CONFIG) as Array<keyof NewsConfig>) {
        if (raw[key] !== undefined) (merged as any)[key] = raw[key];
      }
      current = merged;
      console.log(`[news] config loaded from ${CONFIG_FILE}`);
    }
  } catch (err: any) {
    console.warn(`[news] could not load ${CONFIG_FILE}, using defaults: ${err.message}`);
    current = { ...DEFAULT_NEWS_CONFIG };
  }
  return current;
}

export function getNewsConfig(): NewsConfig {
  return current;
}

// Test/override hook: replace the active config in-process (used by unit tests to
// pin windows without touching disk).
export function setNewsConfig(cfg: Partial<NewsConfig>): NewsConfig {
  current = { ...current, ...cfg };
  return current;
}
