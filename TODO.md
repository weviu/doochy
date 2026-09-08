# TODO — dual-environment support (one agent trading demo + live accounts)

Goal: one DoochyBot agent process can hold sessions on BOTH a demo account and a
live account ("Leveraged", InstantFunding broker) at once. Each environment is a
separate cTrader host with its own access/refresh tokens; symbol ids, quote maps
and subscriptions are per-account. N accounts across M environments, all data
driven — nothing hardcoded to 2.

Config (final shape):

```
CTRADER_CREDENTIALS=[{"env":"demo","accessToken":"...","refreshToken":"..."},{"env":"live","accessToken":"...","refreshToken":"..."}]
CTRADER_ACCOUNTS=[{"login":3064718,"role":"primary","env":"demo"},{"login":5043626,"role":"primary","env":"live"}]
```

- host is derived from env (demo.ctraderapi.com / live.ctraderapi.com); port and
  clientId/clientSecret stay global (identical across envs).
- Legacy single-env config (CTRADER_HOST + CLIENT_ID/… + ACCOUNT_ID/…, or
  CTRADER_ACCOUNTS without env) behaves exactly as today (env inferred from host).

---

## Phase 0 — Config model (environments + account env tagging)
- [x] New `src/ctrader/environments.ts`: EnvName, EnvConfig, `loadEnvironments()`
      (CTRADER_CREDENTIALS or legacy single block), host/port derivation,
      validation (unique envs, tokens present, account envs must be configured).
- [x] `accounts.ts`: `TradingAccount.env`; parse `"env"` per entry; default to the
      single configured env when absent; error when an account names an unknown env.
- [x] `resolveAccounts()` split per env (each env resolves its own accounts from
      its own token; global `resolved` replaced by per-env flag).

## Phase 1 — Per-environment connection layer (lifecycle)
- [x] Replace the single `ctrader`/`cfg()` with a per-env connection registry.
- [x] Per-env build: app auth, account resolution, per-account auth for that env's
      accounts only; per-env session listeners scoped to its accounts.
- [x] Per-env reconnect loop + backoff, per-env health-check watchdog, per-env
      token refresh (rotates only that env's token) + proactive refresh timer.
- [x] `wireConnection` → `wireConnection(env, conn)`; every module setter becomes
      `(env, conn)`.

## Phase 2 — Module routing (all connection consumers)
- [x] orders.ts: per-env connection map + ctid→env routing for all sendCommand sites;
      keep `getConnection(env?)` for slWatchdog.
- [x] livePrices.ts: per-env connections; subscribe spots/conversion pairs per account.
- [x] amend.ts, midnightClose.ts, status.ts, export.ts, engine.ts, history.ts,
      miniapp/service.ts, handlers.ts, sourceWatcher.ts: setter + routing per env.
- [x] Single-env fallback byte-identical to today.

## Phase 3 — Per-account symbol space + quotes
- [x] state.ts: per-account symbol maps (symbolMaps / usdQuoted / symbolQuote /
      tradingDisabled keyed by ctid); symbolIdFor / brokerNameFor / isUsdQuoted
      take an account (ctid); per-account canonical index.
- [x] symbols.ts: fetchSymbols per account (asset + symbol list per primary).
- [x] livePrices.ts: quotes keyed per account; conversion-pair state per account.
- [x] Ripple: pass rt.ctid through every symbolIdFor / quote / valuation call site.

## Phase 4 — Boot wiring + status/UI
- [x] doochybot/index.ts: boot per env/account (fetchSymbols per account BEFORE
      reconcile; fetchAccountInfo per account; subscribe per account; risk engine
      per env connection; reconcile already per account).
- [x] status/positions/mini-app: per-account lines labelled with env (`[demo]` /
      `[live]`); connection refs per env.
- [x] Combined aggregations stay per-account (no demo+live mixing).

## Phase 5 — Wizard + docs
- [ ] `scripts/setup.ts`: collect clientId/secret once; tokens per env (demo, then
      optional live); account list with env; writes CTRADER_CREDENTIALS +
      CTRADER_ACCOUNTS, keeps single-demo output for the common case.
- [ ] `.env.example`, `README.md`, `SETUP.md`: CTRADER_CREDENTIALS format, env
      field, mixed demo+live example, host-derived-from-env note.

## Phase 6 — Verification
- [x] `npx tsc --noEmit` clean; `pnpm build` green.
- [x] `pnpm test:risk`, `pnpm test:timeexit`, `pnpm test:news` pass.
- [ ] Config-parsing checks (env assignment, unknown env rejected, legacy fallback).
- [ ] User verifies live env on the PC agent (hub/dev machine is demo-only).