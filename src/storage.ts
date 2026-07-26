import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths";

// Settings and runtime state live in SEPARATE files:
//  - settings.json: user configuration, written only when the user changes it.
//  - runtime.json: the trading lock, cooldowns, limit override — written by the
//    engine whenever they change (daily at the broker-day rollover, at least).
// They used to share one file, so every routine lock write rewrote all the
// settings from whatever this process had in memory — and a process that had
// failed to LOAD the settings (torn file, crash mid-write) would cement the
// defaults over the user's real configuration within a day.

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const RUNTIME_FILE = path.join(DATA_DIR, "runtime.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Write temp-then-rename so a crash mid-write can never leave a half-written
// file (the old direct writeFileSync could — and a torn settings.json is how
// the defaults-clobber cycle started).
function writeJsonAtomic(file: string, value: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export interface LoadResult {
  data: Record<string, any> | null;
  // True when the file EXISTS but could not be read/parsed. The caller must
  // treat this as "unknown settings", never as "no settings": running on
  // defaults is survivable, but persisting those defaults over the user's real
  // file is not — saveSettings refuses while this is unresolved.
  corrupt: boolean;
}

function loadJson(file: string): LoadResult {
  try {
    if (fs.existsSync(file)) {
      return { data: JSON.parse(fs.readFileSync(file, "utf-8")), corrupt: false };
    }
    return { data: null, corrupt: false };
  } catch (err: any) {
    console.error(`[STORAGE] ${path.basename(file)} exists but cannot be read: ${err.message}`);
    // Preserve the evidence for manual recovery before anything else happens.
    try {
      fs.copyFileSync(file, `${file}.corrupt`);
      console.error(`[STORAGE] Backed up to ${path.basename(file)}.corrupt`);
    } catch { /* the original may be unreadable at the fs level too */ }
    return { data: null, corrupt: true };
  }
}

let settingsCorrupt = false;

export function loadSettings(): Record<string, any> | null {
  const res = loadJson(SETTINGS_FILE);
  settingsCorrupt = res.corrupt;
  return res.data;
}

export function saveSettings(settings: Record<string, any>): void {
  // Never overwrite a file we could not read: this process is running on
  // defaults, and writing them out would destroy the user's real settings.
  // The user's changes in this session are lost on restart until the corrupt
  // file is fixed/removed — loudly say so instead of silently clobbering.
  if (settingsCorrupt) {
    console.error(
      "[STORAGE] NOT saving settings: settings.json was unreadable at boot. " +
      "Fix or delete it (a copy is at settings.json.corrupt) and restart."
    );
    return;
  }
  try {
    writeJsonAtomic(SETTINGS_FILE, settings);
    console.log("[STORAGE] Settings saved");
  } catch (err: any) {
    console.warn(`[STORAGE] Could not save settings: ${err.message}`);
  }
}

// Runtime state (lock, cooldowns, override). A corrupt runtime file is not
// precious the way settings are — it re-derives within a day — so load falls
// back to null and saves always go through.
export function loadRuntime(): Record<string, any> | null {
  return loadJson(RUNTIME_FILE).data;
}

export function saveRuntime(runtime: Record<string, any>): void {
  try {
    writeJsonAtomic(RUNTIME_FILE, runtime);
  } catch (err: any) {
    console.warn(`[STORAGE] Could not save runtime state: ${err.message}`);
  }
}
