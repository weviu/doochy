import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "../paths";

// JSON-file storage for the Hub: users.json (whitelist + last-known settings)
// and agents.json (long-lived agent tokens). Writes go to a temp file in the
// same directory and are renamed over the original, so a crash mid-write can
// never leave a half-written file. Files are tiny (a handful of users), so
// reading on each access is fine and keeps every caller consistent.

const USERS_FILE = path.join(DATA_DIR, "users.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");

export interface UserRecord {
  telegramId: number;
  name: string;
  role: "owner" | "friend";
  // Last-known copy of the agent's settings, for mini-app display while the
  // agent is offline. The agent's own data/settings.json is the authority.
  settings: Record<string, any> | null;
}

export interface AgentRecord {
  userId: number;
  createdAt: string;
  lastSeen: string;
  // Which machine paired (os.hostname() from the agent). Display/debug only;
  // absent on tokens minted before device names existed.
  deviceName?: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: any) {
    console.warn(`[HUB-DB] Could not read ${path.basename(file)}: ${err.message}`);
  }
  return fallback;
}

// Strict read for the agent-auth path: a MISSING file is a genuine empty state
// (fresh hub, no one paired) and returns the fallback, but a read/parse FAILURE
// throws. The lenient readJson above turns a transient failure into "{}", which
// on the auth path looked exactly like "token revoked" — and the agent reacted
// by deleting its saved token, forcing a manual re-pair over a file hiccup.
function readJsonStrict<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// ---- users.json ------------------------------------------------------------

export function getUsers(): Record<string, UserRecord> {
  return readJson<Record<string, UserRecord>>(USERS_FILE, {});
}

export function getUser(userId: number): UserRecord | undefined {
  return getUsers()[String(userId)];
}

// users.json IS the whitelist: unknown Telegram IDs get nothing, including /pair.
export function isKnownUser(userId: number): boolean {
  return getUser(userId) !== undefined;
}

export function getOwnerId(): number | undefined {
  const owner = Object.values(getUsers()).find((u) => u.role === "owner");
  return owner?.telegramId;
}

// Add a user to the whitelist. Returns false if they already exist. Role
// "owner" is only ever assigned by the boot-time seed (HUB_OWNER_ID); the
// /adduser command always adds friends.
export function addUser(userId: number, name: string, role: "owner" | "friend" = "friend"): boolean {
  const users = getUsers();
  if (users[String(userId)]) return false;
  users[String(userId)] = { telegramId: userId, name, role, settings: null };
  writeJsonAtomic(USERS_FILE, users);
  return true;
}

export function setUserSettings(userId: number, settings: Record<string, any>): void {
  const users = getUsers();
  const rec = users[String(userId)];
  if (!rec) return;
  rec.settings = settings;
  writeJsonAtomic(USERS_FILE, users);
}

// ---- agents.json -----------------------------------------------------------

export function getAgents(): Record<string, AgentRecord> {
  return readJson<Record<string, AgentRecord>>(AGENTS_FILE, {});
}

export function findAgentByToken(token: string): AgentRecord | undefined {
  return getAgents()[token];
}

// Auth-path variants: throw on a storage failure instead of reading as empty,
// so the registry can answer "retry later" rather than "revoked".
export function findAgentByTokenStrict(token: string): AgentRecord | undefined {
  return readJsonStrict<Record<string, AgentRecord>>(AGENTS_FILE, {})[token];
}

export function isKnownUserStrict(userId: number): boolean {
  return readJsonStrict<Record<string, UserRecord>>(USERS_FILE, {})[String(userId)] !== undefined;
}

// Tokens whose agent hasn't connected for this long are pruned at the next
// mint. Long enough that a machine off for a season still auths; short enough
// that agents.json doesn't accumulate every token ever minted.
const STALE_TOKEN_MS = 90 * 24 * 3600_000;

// Mint a fresh long-lived token for a user at pairing time. Existing tokens
// for the same user stay VALID: one user may legitimately pair from several
// machines over time (laptop + VPS, a reinstall, a test box), and the old
// revoke-on-mint rule made any pairing anywhere kill every other machine's
// token — the re-pair ping-pong. Stale tokens age out instead.
export function mintAgentToken(userId: number, deviceName?: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  const agents = getAgents();
  const now = Date.now();
  for (const [t, rec] of Object.entries(agents)) {
    const seen = Date.parse(rec.lastSeen || rec.createdAt || "") || 0;
    if (now - seen > STALE_TOKEN_MS) delete agents[t];
  }
  const nowIso = new Date(now).toISOString();
  agents[token] = { userId, createdAt: nowIso, lastSeen: nowIso, ...(deviceName ? { deviceName } : {}) };
  writeJsonAtomic(AGENTS_FILE, agents);
  return token;
}

export function touchAgent(token: string): void {
  const agents = getAgents();
  const rec = agents[token];
  if (!rec) return;
  rec.lastSeen = new Date().toISOString();
  writeJsonAtomic(AGENTS_FILE, agents);
}
