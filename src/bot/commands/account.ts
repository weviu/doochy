import { primaryAccounts, primaryByKey } from "../../ctrader/accounts";

// How a settings-style command ("/risk pertrade 50", "/minhold 30") picks which
// traded account it acts on. Two sources, in precedence order:
//   - a hub-described ctid on ctx.ctid (the mini-app's Settings panel always
//     sends the account it has selected — see handlers.ts runCommand);
//   - a trailing argument matching a primary account by login or ctid, stripped
//     from the tokens (the Telegram convention, "/risk pertrade 50 5860760").
// A single-account bot never needs one and never strips.
//
// Commands that MUST know the account (risk/symbols/minhold/balance) treat a
// multi-account {} with ctid === undefined as an error ("which account?");
// read-only commands (status, settings text) fall back to the default account
// or describe all of them.
export interface CommandAccount {
  // The account the command targets, when one could be resolved.
  ctid: number | undefined;
  // Command tokens after an account argument is stripped.
  parts: string[];
  // True when the bot trades more than one account (an account arg is then
  // meaningful, and for mutations required).
  multi: boolean;
}

export function commandAccount(ctx: any, parts: string[]): CommandAccount {
  const primaries = primaryAccounts();
  const multi = primaries.length > 1;

  // An explicit, validated ctid from the mini-app wins. Anything else — an
  // unknown ctid included — must NOT fall through to trailing-token parsing:
  // the app's command surface is separate from Telegram's text convention.
  if (ctx && ctx.ctid !== undefined) {
    const n = Number(ctx.ctid);
    if (Number.isFinite(n) && n > 0 && primaries.some((a) => a.ctid === n)) {
      return { ctid: n, parts, multi };
    }
    return { ctid: undefined, parts, multi };
  }

  if (!multi) return { ctid: primaries[0]?.ctid, parts, multi: false };

  const last = parts[parts.length - 1];
  const acc = last ? primaryByKey(last) : undefined;
  if (acc) return { ctid: acc.ctid, parts: parts.slice(0, -1), multi: true };
  return { ctid: undefined, parts, multi: true };
}

// Human list of the traded accounts for "which account?" errors, e.g:
//   "5860760 (ctid 456), 1234567 (ctid 890)"
export function accountListText(): string {
  return primaryAccounts()
    .map((a) => (a.login === a.ctid ? `ctid ${a.ctid}` : `${a.login} (ctid ${a.ctid})`))
    .join(", ");
}