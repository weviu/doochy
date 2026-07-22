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
import { CTraderConnection } from "@reiryoku/ctrader-layer";

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
  broker: string;
  isLive: boolean;
}

// Find the user's trading accounts from their app credentials + access token
// (same call as scripts/lookup-account-id.js), so nobody has to hunt for the
// internal ctidTraderAccountId by hand. The account list is app-scoped, so the
// demo endpoint answers for live accounts too.
async function lookupAccounts(clientId: string, clientSecret: string, accessToken: string): Promise<FoundAccount[]> {
  const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), 15_000)),
    ]);

  const connection = new CTraderConnection({ host: "demo.ctraderapi.com", port: 5035 });
  await withTimeout(connection.open(), "connect");
  try {
    await withTimeout(connection.sendCommand("ProtoOAApplicationAuthReq", { clientId, clientSecret }), "app auth");
    const res: any = await withTimeout(
      connection.sendCommand("ProtoOAGetAccountListByAccessTokenReq", { accessToken }),
      "account lookup"
    );
    return (res?.ctidTraderAccount ?? []).map((a: any) => ({
      // int64s arrive as strings from the layer; keep as string for .env.
      id: String(a.ctidTraderAccountId),
      broker: String(a.brokerName ?? "unknown broker"),
      isLive: a.isLive === true || a.isLive === "true",
    }));
  } finally {
    try { connection.close(); } catch { /* done with it */ }
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
    console.log("  3. On that same page, generate the tokens for your cTrader ID");
    console.log("     (approve access to your trading account). Copy the Access token");
    console.log("     and Refresh token.");
    console.log("");
    console.log("That is all: your trading account is found automatically after this.");
    console.log("");

    const clientId = await askRequired("Client ID");
    const clientSecret = await askRequired("Client Secret");
    const accessToken = await askRequired("Access token");
    const refreshToken = await askRequired("Refresh token");

    console.log("");
    console.log("Looking up your trading account...");
    let host = "";
    let accountId = "";
    try {
      const accounts = await lookupAccounts(clientId, clientSecret, accessToken);
      if (accounts.length === 0) throw new Error("the token has no trading accounts attached");
      let picked: FoundAccount;
      if (accounts.length === 1) {
        picked = accounts[0];
      } else {
        console.log("");
        accounts.forEach((a, i) =>
          console.log(`  ${i + 1}. ${a.id} (${a.broker}, ${a.isLive ? "LIVE" : "demo"})`)
        );
        for (;;) {
          const n = parseInt(await askRequired(`Which account? (1-${accounts.length})`));
          if (n >= 1 && n <= accounts.length) { picked = accounts[n - 1]; break; }
          console.log("  Not a valid choice.");
        }
      }
      accountId = picked.id;
      host = picked.isLive ? "live.ctraderapi.com" : "demo.ctraderapi.com";
      console.log(`Using account ${picked.id} (${picked.broker}, ${picked.isLive ? "LIVE" : "demo"}).`);
    } catch (err: any) {
      // Lookup is a convenience; never a dead end. Fall back to manual entry
      // (same as running scripts/lookup-account-id.js later).
      console.log(`Automatic lookup failed (${err?.message || err}).`);
      console.log("Enter the details manually; the account id can be found later with:");
      console.log("  node scripts/lookup-account-id.js");
      const acctType = (await ask("Account type, demo or live", "demo")).toLowerCase();
      host = acctType.startsWith("l") ? "live.ctraderapi.com" : "demo.ctraderapi.com";
      accountId = await askRequired("Account ID (internal ctidTraderAccountId)");
    }

    // Not a question: every normal user connects to the one hub. Overridable
    // via env only for development (HUB_WS_URL=... pnpm doochybot:setup).
    const hubUrl = process.env.HUB_WS_URL || "wss://doochy.route07.com/ws";

    fs.writeFileSync(ENV_FILE, [
      `CTRADER_HOST=${host}`,
      "CTRADER_PORT=5035",
      `CLIENT_ID=${clientId}`,
      `CLIENT_SECRET=${clientSecret}`,
      `ACCESS_TOKEN=${accessToken}`,
      `REFRESH_TOKEN=${refreshToken}`,
      `ACCOUNT_ID=${accountId}`,
      `HUB_WS_URL=${hubUrl}`,
      "",
    ].join("\n"));
    console.log("");
    console.log(".env written.");
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
