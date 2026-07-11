import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadSettings(): Record<string, any> | null {
  try {
    ensureDataDir();
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err: any) {
    console.warn(`[STORAGE] Could not load settings: ${err.message}`);
  }
  return null;
}

export function saveSettings(settings: Record<string, any>): void {
  try {
    ensureDataDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
    console.log("[STORAGE] Settings saved");
  } catch (err: any) {
    console.warn(`[STORAGE] Could not save settings: ${err.message}`);
  }
}
