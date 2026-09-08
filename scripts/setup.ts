// First-run setup wizard for a DoochyBot user: asks for the cTrader
// credentials, writes .env, builds, and offers to start right away (which
// then prompts for the Telegram pairing code). Run with: pnpm doochybot:setup
// (plain "pnpm setup" is a pnpm builtin and does something else entirely).
//
// Deliberately does not overwrite an existing .env: re-running the wizard on
// a configured machine must never wipe working credentials.

import fs from "fs";
import path from "path";
import readline from "readline";
import { spawnSync } from "child_process";
import { hostForEnv } from "../src/ctrader/environments";
import { fetchBrokerDirectory } from "../src/ctrader/brokerDirectory";

const ENV_FILE = path.join(process.cwd(), ".env");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Answer plumbing that also survives piped/pasted input: rl.question drops
// lines that arrive while no question is pending (all piped lines flush in one
// tick), so buffer every line ourselves and hand them out one ask at a time.
const pendingLines: string[] = [];
let lineWaiter: ((line: string) => void) | null = null;
let stdinClosed = false;
rl.on("line", (line) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
  else pendingLines.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(""); }
});

function readLine(): Promise<string> {
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift()!);
  if (stdinClosed) return Promise.resolve("");
  return new Promise((resolve) => { lineWaiter = resolve; });
}

async function ask(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  process.stdout.write(`${question}${suffix}: `);
  const a = (await readLine()).trim();
  return a || fallback;
}

async function askRequired(question: string): Promise<string> {
  for (;;) {
    const a = await ask(question);
    if (a) return a;
    if (stdinClosed && pendingLines.length === 0) {
      console.error("\nInput ended before all required values were provided.");
      process.exit(1);
    }
    console.log("  This one is required.");
  }
}

function run(cmd: string, args: string[], extraEnv?: Record<string, string>): number {
  // shell:true so this works on Windows too (pnpm is a .cmd shim there).
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return r.status ?? 1;
}

interface FoundAccount {
  id: string;
  isLive: boolean;
}

// What one collected environment contributes: which env it is and the account
// An account as shown to the user. The picker runs on the REST directory, which
// answers in human terms: the internal ctidTraderAccountId (what .env needs),
// the platform LOGIN the user actually remembers, and the broker name. Choosing
// an account chooses its environment automatically via isLive — the user never
// answers a demo/live question.
interface FoundAccount {
  id: string; // internal ctidTraderAccountId -> ACCOUNT_ID / CTRADER_ACCOUNTS[].ctid
  isLive: boolean;
  login: number | null; // platform login (accountNumber), null on manual entry
  brokerName: string;
  brokerTitle: string | null;
}

// Pick the accounts to trade in ONE step, using the shared access token. ONE
// app token answers for ALL the user's accounts (demo and live alike) via the
// REST directory, so no broker connection is needed: broker name, login and
// demo/live come straight from cTrader. Falls back to manual entry if the
// lookup itself fails, so a credentials hiccup is never a dead end.
async function pickAccounts(accessToken: string): Promise<FoundAccount[]> {
  console.log("");
  console.log("Looking up your trading accounts (shared token)...");

  let accounts: FoundAccount[];
  try {
    const dir = await fetchBrokerDirectory(accessToken);
    accounts = [...dir.values()].map((e) => ({
      id: String(e.accountId),
      isLive: e.live,
      login: e.accountNumber || null,
      brokerName: e.brokerName,
      brokerTitle: e.brokerTitle,
    }));
    if (accounts.length === 0) throw new Error("the token has no trading accounts attached");
  } catch (err: any) {
    console.log(`Automatic lookup failed (${err?.message || err}).`);
    console.log("Enter the details manually; the account id can be found later with:");
    console.log("  node scripts/lookup-account-id.js");
    const raw = await askRequired("Account IDs to trade (comma separated ctidTraderAccountIds)");
    const ids = raw.split(/[, ]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) process.exit(1);
    const out: FoundAccount[] = [];
    for (const id of ids) {
      const live = (await ask(`Is account ${id} LIVE or demo? (live/demo)`, "demo")).toLowerCase();
      out.push({ id, isLive: live.startsWith("l"), login: null, brokerName: "", brokerTitle: null });
    }
    for (const a of out) console.log(`Using account ${a.id} ${a.isLive ? "(LIVE)" : "(demo)"}.`);
    return out;
  }

  const tag = (a: FoundAccount) =>
    `${a.login ?? a.id} ${a.brokerTitle || a.brokerName} (${a.isLive ? "LIVE" : "demo"})`;
  console.log("");
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${tag(a)}`));
  for (;;) {
    const raw = await askRequired("Which account(s) to trade? (comma separated, e.g. 1,3)");
    const ns = raw
      .split(/[, ]+/)
      .map((s) => parseInt(s))
      .filter((n) => Number.isInteger(n));
    if (ns.length >= 1 && ns.every((n) => n >= 1 && n <= accounts.length)) {
      const picked = ns.map((n) => accounts[n - 1]);
      for (const a of picked) console.log(`Using account ${tag(a)}.`);
      return picked;
    }
    console.log("  Not a valid choice (one or more numbers separated by commas).");
  }
}

async function main() {
  console.log("DoochyBot setup");
  console.log("---------------");

  if (fs.existsSync(ENV_FILE)) {
    console.log(".env already exists; keeping it (delete it first to reconfigure).");
  } else {
    console.log("You need your own cTrader Open API application:");
    console.log("");
    console.log("  1. Go to https://openapi.ctrader.com/apps and press 'Add new app'");
    console.log("     (any name). Wait for it to show as Active.");
    console.log("  2. Press 'Credentials' next to your app. Copy the Client ID and");
    console.log("     Client Secret.");
    console.log("  3. On that same page, generate the access/refresh token pair for");
    console.log("     your cTrader ID (approve access to your trading account). ONE");
    console.log("     pair works for all your demo AND live accounts — generating a");
    console.log("     second pair would invalidate the first.");
    console.log("");
    console.log("That is all: your trading account is found automatically after this.");
    console.log("");

    const clientId = await askRequired("Client ID");
    const clientSecret = await askRequired("Client Secret");

    console.log("");
    const accessToken = await askRequired("Access token");
    const refreshToken = await askRequired("Refresh token");

    // One lookup, one pick: the user chooses accounts (not environments).
    // Whether a picked account is LIVE or demo (isLive) decides the env
    // automatically, so "live" config appears exactly when a live account is
    // selected — no demo/live questions at all.
    const picked = await pickAccounts(accessToken);
    if (picked.length === 0) process.exit(1);

    // Not a question: every normal user connects to the one hub. Overridable
    // via env only for development (HUB_WS_URL=... pnpm doochybot:setup).
    const hubUrl = process.env.HUB_WS_URL || "wss://doochy.route07.com/ws";

    const accountOf = (a: FoundAccount) => ({
      ctid: Number(a.id),
      role: "primary",
      env: a.isLive ? "live" : "demo",
    });
    const accounts = picked.map(accountOf);
    const envs = [...new Set(accounts.map((a) => a.env))]; // order of selection

    if (picked.length === 1) {
      // Single account: keep the byte-identical legacy flat format so an
      // existing single-account deployment is indistinguishable from before.
      // The host selects the environment (live host => live env).
      const only = picked[0];
      fs.writeFileSync(ENV_FILE, [
        `CTRADER_HOST=${hostForEnv(only.isLive ? "live" : "demo")}`,
        "CTRADER_PORT=5035",
        `CLIENT_ID=${clientId}`,
        `CLIENT_SECRET=${clientSecret}`,
        `ACCESS_TOKEN=${accessToken}`,
        `REFRESH_TOKEN=${refreshToken}`,
        `ACCOUNT_ID=${only.id}`,
        `HUB_WS_URL=${hubUrl}`,
        "",
      ].join("\n"));
      console.log("");
      console.log(`.env written (${only.isLive ? "live" : "demo"}).`);
    } else {
      // Multi-account (or mixed demo+live): the access/refresh token pair is
      // SHARED (one app token authenticates every host), written once as the
      // flat ACCESS_TOKEN/REFRESH_TOKEN; CTRADER_CREDENTIALS carries just the
      // environment list (host derived from env, port + clientId/secret shared);
      // the account list carries each entry's env. loadEnvironments always
      // prefers the flat token variables, so this is the one true format.
      const creds = envs.map((env) => JSON.stringify({ env }));
      fs.writeFileSync(ENV_FILE, [
        "CTRADER_PORT=5035",
        `CLIENT_ID=${clientId}`,
        `CLIENT_SECRET=${clientSecret}`,
        `ACCESS_TOKEN=${accessToken}`,
        `REFRESH_TOKEN=${refreshToken}`,
        `CTRADER_CREDENTIALS=[${creds.join(",")}]`,
        `CTRADER_ACCOUNTS=[${accounts.map((a) => JSON.stringify(a)).join(",")}]`,
        `HUB_WS_URL=${hubUrl}`,
        "",
      ].join("\n"));
      console.log("");
      console.log(`.env written (${envs.join(" + ")}, shared token).`);
    }
  }

  console.log("");
  console.log("Building...");
  // Agent-only build (tsc): a user setting up their local agent doesn't need the
  // webapp or channel-listener (those run on the central hub). `pnpm build` builds
  // the whole workspace; here we compile just the agent so setup stays fast and
  // never fails on a frontend build the user will never run.
  if (run("pnpm", ["exec", "tsc"]) !== 0) {
    console.error("Build failed; fix the error above and re-run pnpm doochybot:setup.");
    process.exit(1);
  }

  const start = (await ask("Start DoochyBot now? (y/n)", "y")).toLowerCase();

  if (start.startsWith("y")) {
    // If not paired yet, collect the /pair code HERE, in the wizard's own
    // (working) readline, and pass it to the agent via AGENT_PAIR_CODE. We do
    // NOT let the agent prompt for it: the agent runs as a shell grandchild of
    // this wizard, and on Windows that inherited/closed stdin often never
    // delivers lines to the grandchild's readline, so a code typed there is
    // silently lost. An env var needs no readline and always works.
    const tokenFile = path.join(process.cwd(), "data", "doochybot-token.json");
    let alreadyPaired = false;
    try { alreadyPaired = !!JSON.parse(fs.readFileSync(tokenFile, "utf-8")).token; } catch { /* not paired */ }

    const env: Record<string, string> = {};
    if (!alreadyPaired) {
      console.log("");
      console.log("Send /pair to @DoochyBot in Telegram to get a 6-character code.");
      const code = await askPairCode();
      rl.close();
      if (!code) {
        console.log("No code entered. Start later with: pnpm doochybot:start (it will ask again),");
        console.log("or:  AGENT_PAIR_CODE=YOURCODE pnpm doochybot:start");
        process.exit(0);
      }
      env.AGENT_PAIR_CODE = code;
    } else {
      rl.close();
    }

    process.exit(run("node", [path.join("dist", "doochybot", "index.js")], env));
  }
  rl.close();
  console.log("Done. Start any time with: pnpm doochybot:start");
}

// Pair codes are 6 chars from the Hub's unambiguous alphabet (no 0/O/1/I).
const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// Ask for the pairing code using the wizard's own readline (which works, since
// the user already answered the credential questions through it). Re-asks on a
// malformed entry; returns "" if input ends so the caller can fall back.
async function askPairCode(): Promise<string> {
  for (;;) {
    const raw = (await ask("Pairing code")).trim().toUpperCase();
    if (PAIR_CODE_RE.test(raw)) return raw;
    if (stdinClosed && pendingLines.length === 0) return "";
    if (raw.length === 0) console.log("  Paste the 6-character code from /pair.");
    else console.log(`  "${raw}" is not a valid code (6 characters, A-Z and 2-9). Try again.`);
  }
}

main();
