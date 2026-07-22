import fs from "fs";
import path from "path";

// Persistent record of every source-account position already written to the
// alerts feed, so a position is NEVER copied twice.
//
// This is deliberately disk-backed rather than in-memory. The same class of bug
// has already happened in this codebase once: orders.ts's close-tracking used an
// in-memory `countedDeals` set, a reconnect registered a second listener, and the
// same close was counted twice against the daily loss limit (see orders.ts, the
// "Count each closing deal ONCE" comment). In-memory state also dies on restart,
// and the multi-account work proved two connections CAN serve the same account
// concurrently on this broker - so a restarting subscriber can genuinely see a
// fill that an older, not-yet-dead connection already wrote.
//
// Stored as a plain array of position ids (newest last), capped so the file can't
// grow without bound on a long-lived account.

const STORE_FILE = path.join(process.cwd(), "data", "copytrade-written.json");
const MAX_IDS = 5000;

let written: number[] = [];
let index = new Set<number>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
      if (Array.isArray(raw)) {
        written = raw.map(Number).filter((n) => Number.isFinite(n)).slice(-MAX_IDS);
        index = new Set(written);
      }
    }
  } catch (err: any) {
    // A corrupt/unreadable store must NOT be treated as "nothing written yet":
    // that would re-copy every position the source account still holds. Fail
    // loud and leave the set empty-but-loaded so the caller's own guard logs it.
    console.error(`[COPYTRADE] Could not read ${STORE_FILE}: ${err.message}. Duplicate protection is degraded for this run.`);
  }
  console.log(`[COPYTRADE] Duplicate guard loaded: ${written.length} position(s) previously written`);
}

// True if this position has already been written to the feed.
export function alreadyWritten(positionId: number): boolean {
  load();
  return index.has(positionId);
}

// Record a position as written. Persisted SYNCHRONOUSLY and before the alert is
// considered done, so a crash between "wrote the alert" and "recorded the id"
// cannot lose the record and cause a duplicate on restart.
export function markWritten(positionId: number): void {
  load();
  if (index.has(positionId)) return;
  written.push(positionId);
  index.add(positionId);
  if (written.length > MAX_IDS) {
    const dropped = written.splice(0, written.length - MAX_IDS);
    for (const id of dropped) index.delete(id);
  }
  const tmp = `${STORE_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(written), "utf-8");
    fs.renameSync(tmp, STORE_FILE);
  } catch (err: any) {
    console.error(`[COPYTRADE] Could not persist duplicate guard: ${err.message}. Position ${positionId} may be re-copied after a restart.`);
  }
}
