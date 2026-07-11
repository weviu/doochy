# DoochyBot: Capabilities Summary

A reference document describing everything DoochyBot does, intended for evaluating its readiness for a live funded trading account. It reflects the current state of the codebase, not the original design notes. Where a feature commonly assumed to exist is absent or was removed, that is called out explicitly.

---

## 1. Overview

DoochyBot is an automated trading bot for the cTrader (Spotware Open API) platform, controlled and monitored through Telegram. It receives trade signals from external sources, runs each signal through a multi-stage risk gate, and places orders on a cTrader account. Stop loss and take profit are managed automatically, and a layer of daily and per-trade safety controls is designed to keep the account inside prop-firm risk rules.

Primary purpose: take third-party signals (an RSI feed and the SureShot Gold Telegram channel), filter them for risk compliance, and execute them on a funded cTrader account with minimal manual intervention, while enforcing daily loss limits, a daily profit cap, and per-trade-idea risk limits required by prop firms such as InstantFunding.

---

## 2. Architecture

Two independent Node.js processes, managed by pm2 (`ecosystem.config.js`):

1. **DoochyBot (main process, `src/`)**: connects to cTrader over the Open API, runs the Telegram command bot, polls the RSI signal feed, exposes a local webhook, and owns all order execution and risk logic.
2. **Channel listener (`channel-listener/`)**: a separate process with its own dependencies. It logs into Telegram as a user account (MTProto, via gramJS), reads the SureShot Gold channel, and forwards parsed signals to the main process over HTTP. It shares no code or state with the main bot, only the webhook URL.

The two communicate one way: the channel listener formats a signal and POSTs it to DoochyBot's webhook. If either process is down, the other keeps running.

The external RSI signal feed (referred to as MiniSig) is a third-party service that generates the signals and is responsible for any trend filtering or signal quality logic. DoochyBot consumes its JSON output and does no signal generation or trend analysis of its own.

### Tech stack

- Node.js 20, TypeScript (CommonJS, compiled to `dist/` with `tsc`).
- Main bot dependencies: `@reiryoku/ctrader-layer` (cTrader Open API protobuf client), `grammy` (Telegram bot framework), `dotenv`.
- Channel listener dependency: `telegram` (gramJS, MTProto user client). Plus a minimal inline `.env` loader and Node's built-in `readline`; gramJS is its only runtime dependency.
- Dev/runtime tooling: `tsx` (dev runner), `pm2` (process manager), `typescript`.
- Persistence: a single JSON file (`data/settings.json`) for settings. No database.

### Boot sequence (main process)

1. Load settings from `data/settings.json`.
2. Connect to cTrader: open socket, application auth, account auth. A 10s heartbeat keeps the push channel alive.
3. Fetch account info (balance) and the symbol list (name to symbolId map).
4. Pre-subscribe spot price streams for all allowed symbols so risk sizing has a live price for the first trade.
5. Seed today's realized P&L from the broker (retried once; if it fails, daily limits are disabled for the session rather than run against a false zero).
6. Reconcile open positions from the broker (rehydrates positions opened before restart and re-arms their TPs).
7. Subscribe spot streams for already-open positions.
8. Start the Telegram bot, the RSI poller, and the webhook server.
9. Start the background safety timers (midnight closer, daily reset, profit-cap monitor, daily-loss monitor).

---

## 3. Signal Sources

### 3.1 RSI JSON feed (poller)

- Source: `https://signals.route07.com/alerts.json`, polled every 10 seconds (`src/signals/poller.ts`).
- On first poll it records the latest timestamp and processes nothing (avoids replaying history). After that, any alert newer than the last seen timestamp is processed oldest-first.
- Signal format (`RawAlert`): JSON objects with `timestamp`, `symbol`, `timeframe`, `direction`, `rsi`, `price`, `pivot_level`, `pivot_distance`, `confidence`.
- Parsing (`src/signals/parser.ts`): resolves the feed symbol to the broker symbol. A few explicit aliases exist (for example AAVE to AAVUSD, LINK to LNKUSD, US30 to "US 30", US100 to "US TECH 100"); otherwise the base symbol gets a `USD` suffix. Direction must be BUY or SELL. The result is a `ParsedSignal` carrying `rsi`, `price`, `confidence`, `timeframe`, and timestamp. These feed signals are always treated as market orders and do not carry their own SL/TP.
- Each parsed signal is passed directly into the risk gate (`processSignal`).

### 3.2 SureShot Gold Telegram channel (channel listener)

- A gramJS user client logs in as a Telegram account that must be a member of the channel. The channel is resolved from either a public `@username` or a private `t.me/+invite` link.
- Two delivery paths feed one deduplicated handler:
  - Push updates: instant delivery via Telegram's update stream.
  - Polling: every 15 seconds the listener fetches the channel's recent messages directly and processes any new ones. This is a reliability safety net, because a single channel's push stream can silently desync and stop delivering while the rest of the account keeps working. Messages are deduplicated by message id, so nothing is processed twice. Worst-case added latency for the fallback path is about 15 seconds.
- Parsing (`channel-listener/src/parser.ts`): the channel posts a signal across one or more messages. A signal starts with a line matching a symbol plus BUY or SELL, an optional LIMIT keyword, and a price (for example `XAUUSD SELL LIMIT 4329`). The parser then buffers until it has both an `SL:` and a `TP:` line. Noise messages (containing CLOSE, PIPS, VIP, MOVE SL, PROFIT, or RUNNING) and signature lines (`--Trade by ...`) are ignored. An incomplete buffer is discarded after 30 seconds of silence or when a new signal start arrives. The symbol is extracted from the message rather than hardcoded.
- The parsed signal `{ symbol, direction, orderType, entry, sl, tp }` is sent to DoochyBot's webhook as plain text.

### 3.3 Local webhook endpoint

- An Express server in the main process listens on `127.0.0.1:9009`, route `POST /webhook` (`src/webhook.ts`). Loopback only, no authentication (it is never exposed to the internet; only the local channel listener calls it).
- Body is plain text in DoochyBot's standard format:
  - Market: `SELL XAUUSD SL=4337.05 TP=4307.05`
  - Limit: `SELL XAUUSD LIMIT=4329 SL=4350 TP=4300`
- It parses the text into a `ParsedSignal` (defaulting feed-only fields like rsi/confidence to 0), then calls the same `processSignal` gate the poller uses. Responses: 400 if the text cannot be parsed; 200 with a "rejected: reason" message if the gate rejects it; 200 with a success message if it begins executing.

### 3.4 Other sources

None. The poller and the webhook (fed by the channel listener) are the only two entry points. Both converge on the same `processSignal` gate.

---

## 4. Risk Management (The Gate)

Every signal, from either source, passes through `processSignal` in `src/risk/gate.ts`. Checks run in this order; the first failure rejects the signal and returns a reason.

1. **Trading paused** (Check 1): if `/pause` is active, reject. Controlled by `/pause` and `/resume`.
2. **Re-entry cooldown after a loss** (Check 1b): if this exact symbol and direction had a losing close within `reentryCooldownMinutes`, reject with "Cooldown active: Xm Ys remaining". Opposite direction and prior wins are unaffected. Configured via `/risk reentry <min>` (default 10, currently 11; 0 = off).
3. **Combined per-trade-idea risk** (Check 1c): sums the potential loss of all open positions of the same symbol and direction and rejects if adding this signal would push the total over `maxCombinedRiskUSD`. The new signal's risk is estimated as `riskPerTradeUSD`; existing positions use the exact formula `abs(entry - sl) * volumeCents / 100`, or fall back to `riskPerTradeUSD` if a position has no SL yet. Configured via `/risk combined <usd>` (default 0 = off, currently 120). Skipped entirely when 0.
4. **Symbol whitelist** (Check 2): reject if the symbol is not in `allowedSymbols`.
5. **Symbol available on broker** (Check 2b): reject if the symbol is not in the broker's symbol map.
6. **Consecutive-loss cooldown** (Check 3): if the symbol is in a cooldown triggered by too many stop-loss hits in a window, reject. Configured via `/risk losses`, `/risk losswindow`, `/risk cooldown`. This is per symbol (either direction), distinct from the re-entry cooldown.
7. **One position per symbol / reversal** (Check 4): if a position already exists on the symbol:
   - Same direction: reject ("Already holding"). The bot never stacks same-direction positions through the gate.
   - Opposite direction: flip only if the new signal's confidence is strictly higher than the open position's; otherwise reject. A successful flip triggers a reversal (close then open).
8. **Pending order for same symbol and direction** (Check 4b): reject if an order is already submitted and awaiting fill, so a repeating signal does not submit duplicates.
9. **Max positions** (Check 5): reject if the open-position count is at `maxPositions`. Configured via `/risk maxpos` (default 3, currently 4).
10. **Daily limit lock** (Check 6): re-evaluates daily limits and rejects if trading is locked by the daily loss limit or the profit cap.
11. **Duplicate signal within 60 seconds** (Check 7): reject a repeat of the same symbol and direction within 60s.

If all checks pass, the signal is sized and executed (market) or rested (limit). Note there is no in-bot trend filter; that responsibility sits with the upstream feed.

---

## 5. Order Execution

Handled in `src/ctrader/orders.ts`.

### Volume calculation (sizing)

- Sizing is risk-based only. There is no fixed-lot mode. Volume is computed so that a `stopLossPercent` move against the position loses approximately `riskPerTradeUSD`, using the live mark price; if no live quote has streamed yet, it falls back to the signal's own price (feed price or channel limit price). If no price is available at all, or if `riskPerTradeUSD` is 0, the trade is refused rather than sent unsized. The computed volume is snapped to the broker's min, step, and max.
- A note on accuracy: the volume is sized from the `stopLossPercent` setting, while a channel signal's actual SL may be at a different distance. So a channel order's real risk can differ from `riskPerTradeUSD`.

### Market vs limit orders

- Feed signals and channel signals without the LIMIT keyword are sent as MARKET orders with IMMEDIATE_OR_CANCEL.
- Channel signals with LIMIT are placed as resting LIMIT orders at the given price, GOOD_TILL_CANCEL, with SL and TP attached directly to the order so the resting order is self-contained and survives a bot restart.

### SL/TP attachment

- Market orders: on fill, SL and TP are applied by amending the position (`src/ctrader/amend.ts`). SL is set immediately; TP is delayed until the min-hold timer elapses. If the signal carries no SL/TP (feed signals), they are computed as `stopLossPercent` and `takeProfitPercent` of the entry. Channel signals supply absolute SL/TP, which take precedence.
- Limit orders: SL and TP are attached to the order at placement.
- If a daily profit cap is set, the amend logic may tighten a position's TP to a "cap TP" so the position closes at the remaining daily headroom (split across open positions). This is a broker-side backstop that works even if the bot is offline.

### Min hold timer

- `minHoldSeconds` (default 60, currently 125) delays setting the TP after fill, so positions are not immediately closed by a tight take profit. If a position has already been open longer than the hold period, the delay is zero.

### Fill handling, timeouts, cancellation

- Market orders: the bot waits up to 30 seconds for a fill. On timeout it cancels the still-resting order at the broker (and logs the case where the broker never acknowledged, which usually means an outright rejection).
- Limit orders: the bot waits only for the order to be accepted (resting) or rejected, then returns, leaving the order live; a persistent listener records the position when it eventually fills. The 30s auto-cancel does not apply to limit orders.

### Startup reconciliation

- On boot, `reconcilePositions()` reads open positions from the broker and rebuilds the in-memory position map (symbol, direction, entry, volume, SL, TP), so the bot can manage positions it did not open this session, and re-arms TPs where missing.

---

## 6. Position Management

- **In-memory tracking**: open positions are held in a map keyed by broker position id, each with symbol, direction, lots and broker volume, entry price, open time, confidence, and SL/TP. P&L per position is computed live as `priceDiff * volumeCents / 100` using the cTrader spot stream.
- **Reversal logic** (`src/risk/reversal.ts`): when an opposite-direction signal with strictly higher confidence arrives for a symbol already held, the bot closes the existing position, waits about one second for the broker to settle, then opens the new one. If the close succeeds but the new open fails, it sends a CRITICAL Telegram alert that the account may be unhedged.
- **One position per symbol**: enforced in the gate. The bot will not stack two same-direction positions on one symbol via signals (multiple same-idea positions can still exist from manual trades or reconciliation, which the combined-risk check accounts for).
- **closeall**: `/closeall` closes every open position, one at a time, reporting how many closed and how many failed. The same routine is used by the midnight closer and the daily-limit force-close.
- **P&L**: realized daily P&L is seeded from the broker at boot, updated on each close, and reset at 00:00 UTC. Floating P&L is summed live from spot prices.

---

## 7. Telegram Commands

Only Telegram user IDs in `ALLOWED_USERS` may issue commands; others get "Unauthorized". The actual implemented command set:

### Control
- `/start`: greeting, points to `/guide` and `/help`.
- `/guide`: step-by-step setup walkthrough.
- `/help`: full command reference.
- `/pause`: stop executing signals.
- `/resume`: resume executing signals; also clears a daily loss/profit-cap lock.
- `/closeall`: close all open positions immediately.

### Symbols
- `/symbols`: list allowed symbols.
- `/symbols add <SYM>`: add a symbol.
- `/symbols add all`: add all feed symbols with confidence at least 3.
- `/symbols remove <SYM>`: remove a symbol.
- `/symbols reset`: restore the default list (BTCUSD, XAUUSD, XAGUSD).

### Sizing
- `/risk pertrade <usd>`: dollar risk per trade; the bot sizes lots to match (0 = trading off). Required for any trade to execute.

### Stop / target
- `/risk sl <pct>`: stop distance as percent of entry (also drives trade size).
- `/risk tp <pct>`: take-profit distance as percent of entry.
- `/minhold <secs>`: seconds to hold before the TP is set.

### Daily limits
- `/risk maxloss <usd>`: daily loss limit in dollars (force-close all and stop for the day).
- `/risk cap <usd>`: daily profit cap (0 = off).
- `/risk capbuffer <usd>`: trigger the cap this many dollars early.
- `/risk maxpos <n>`: max concurrent open positions.
- `/risk combined <usd>`: max summed risk across same symbol and direction positions (0 = off).

### Cooldowns
- `/risk losses <n>`: stop-loss hits within the window that trigger a per-symbol cooldown (0 = off).
- `/risk losswindow <min>`: window for counting those hits.
- `/risk cooldown <min>`: per-symbol cooldown length.
- `/risk reentry <min>`: after a losing close, block reopening the same symbol and direction for this long (0 = off).
- `/cooldown`: list symbols currently in cooldown.
- `/cooldown reset [sym]`: clear a symbol's cooldown, or all.

### Info
- `/status`: connection, account balance, trading state, open positions, realized and floating P&L, profit-cap progress, daily loss limit, current sizing, cooldowns.
- `/positions`: per-position direction, symbol, lots, entry, mark, SL, TP, and P&L.
- `/export [from] [to]`: export closed-trade history as a JSON file, classifying each exit as TP, SL, stop-out, or market, with time held and net P&L. Defaults to the last 7 days; accepts date or date-with-time ranges.

### Commands that do NOT exist (despite sometimes being assumed)
- `/balance`: not a standalone command; balance is shown in `/status`.
- `/confirm`, `/risk mode`: not implemented.
- `/risk lotsize` and `/symbols <SYM> <lots>` (fixed-lot sizing): removed. Sizing is risk-based only.
- `/risk daily <pct>` (percent daily loss limit): removed; only the absolute dollar `/risk maxloss` remains.

---

## 8. Configuration

### `data/settings.json` (managed via Telegram, persisted on change)

Current live values, with defaults in parentheses:

- `allowedSymbols`: BTCUSD, XAUUSD, XAGUSD (default same).
- `maxPositions`: 4 (default 3).
- `maxDailyLossUSD`: 300 (default 200).
- `stopLossPercent`: 0.4 (default 0.5).
- `takeProfitPercent`: 0.5 (default 0.75).
- `minHoldSeconds`: 125 (default 60).
- `riskPerTradeUSD`: 50 (default 0 = trading off until set).
- `dailyProfitCapUSD`: 360 (default 0 = off).
- `capBufferUSD`: 30 (default 0).
- `maxConsecutiveLosses`: 3 (default 3).
- `lossWindowMinutes`: 60 (default 60).
- `cooldownMinutes`: 60 (default 120).
- `reentryCooldownMinutes`: 11 (default 10; 0 = off).
- `maxCombinedRiskUSD`: 120 (default 0 = off).

### `.env` (main process)

- `CTRADER_HOST`: `demo.ctraderapi.com` or `live.ctraderapi.com`. Currently `live`.
- `CTRADER_PORT`: 5035.
- `CLIENT_ID`, `CLIENT_SECRET`: cTrader Open API app credentials.
- `ACCESS_TOKEN`, `REFRESH_TOKEN`: OAuth tokens for the account.
- `ACCOUNT_ID`: numeric cTrader account id.
- `TELEGRAM_BOT_TOKEN`: bot token from BotFather.
- `ALLOWED_USERS`: comma-separated Telegram user ids allowed to send commands.

### `channel-listener/.env`

- `API_ID`, `API_HASH`: Telegram API credentials from my.telegram.org.
- `PHONE_NUMBER`: the user account's phone (must be a member of the channel).
- `CHANNEL_USERNAME`: public username or private invite link of the channel.
- `WEBHOOK_URL`: defaults to `http://localhost:9009/webhook`.

The RSI feed URL (`signals.route07.com/alerts.json`) and its 10s interval are hardcoded in the poller, not configurable via settings or env.

---

## 9. Safety Features

- **Daily loss limit**: an absolute dollar limit (`maxDailyLossUSD`). The gate blocks new signals once breached. A dedicated monitor (`lossMonitor.ts`) polls realized plus floating P&L every second and force-closes all positions when the combined loss reaches the limit, requiring two consecutive breach ticks and live quotes on every open position before acting.
- **Daily profit cap**: `dailyProfitCapUSD` with a `capBufferUSD`. Three enforcement layers: a 1-second monitor that force-closes everything on breach (primary), a broker-side per-position cap TP that fires even if the bot is down, and the gate blocking new signals once locked.
- **Per-trade risk sizing**: every trade is sized to risk approximately `riskPerTradeUSD`; trading is refused entirely if this is not set or no price is available (no unsized fallback).
- **Combined risk tracking**: per-trade-idea (same symbol and direction) summed risk limit for prop-firm compliance.
- **Re-entry cooldown**: after any losing close, the same symbol and direction is blocked for a window (prop-firm same-trade-idea rule).
- **Consecutive-loss protection**: a symbol that takes too many stop-loss hits in a window is paused for a cooldown.
- **Minimum hold time**: delays the TP so positions are not closed instantly.
- **Midnight safety close**: closes all positions at 21:55 UTC, ahead of the broker's daily reset window, to protect prop-firm accounts.
- **Startup reconciliation**: rebuilds position state from the broker and re-arms protective TPs after a restart.
- **Duplicate prevention**: the 60-second duplicate gate plus the pending-order check prevent repeat or stacked orders.
- **P&L seeding guard**: if the broker P&L seed fails at boot, daily limits are disabled for the session rather than run against a false zero.
- **Graceful error handling**: bad or unparseable signals are logged and skipped; webhook failures are logged and dropped; cTrader heartbeats keep the push channel alive; the channel listener has a liveness watchdog and self-restarts via pm2 on a dead connection. The bot is designed to log on everything and crash on nothing.

---

## 10. Known Limitations and Gaps

- **In-memory risk state resets on restart.** Re-entry cooldowns, consecutive-loss cooldowns, and the daily-limit lock are not persisted. Daily realized P&L is re-seeded from the broker, but a restart clears active cooldowns and any lock, which could allow a re-entry that a prop rule would still forbid.
- **Daily loss force-close can overshoot in fast markets.** The loss monitor needs live quotes on all positions and a ~2 second confirmation plus a close round-trip. Historical logs show the daily loss limit being exceeded (one instance at roughly minus 622 dollars against a 300 dollar limit). For a funded account this is the most important gap to validate before trusting it unattended.
- **SL amend confirmation can be missed.** The amend waits 5 seconds for a broker confirmation; a missed confirmation is logged but not retried in isolation (it is usually re-sent alongside the TP after min-hold). Worth verifying that every filled position ends up with a confirmed stop.
- **Channel sizing mismatch.** Volume is sized from `stopLossPercent`, not the channel signal's actual SL distance, so a channel trade's real risk can differ from `riskPerTradeUSD`. The combined-risk check uses the precise stored SL for existing positions but estimates the incoming one as `riskPerTradeUSD`.
- **Single Telegram account for the listener.** The listener logs in as one user account. Sharing that account or session across machines causes problems. The per-channel push stream can desync; the 15-second poll mitigates this but adds up to 15 seconds of latency on the fallback path.
- **Approximations.** Account equity is reported as balance (no live equity). Floating P&L assumes USD-quoted instruments (accurate for XAU, BTC, XAG; not generalized).
- **Single broker and account.** cTrader Open API only, one account, demo or live by host config.
- **No automated test suite or CI** in the repository.
- **Stale wording.** The `/risk pertrade` reply text and parts of the README still mention fixed-lot sizing, which no longer exists.
- **Webhook has no authentication.** Safe because it binds to loopback only, but it would be open if ever exposed.
- **No trend filter in the bot.** Signal quality depends entirely on the upstream feed and the channel.
- **Intentionally deferred.** Channel trade-management messages (CLOSE PARTIAL, MOVE SL TO ENTRY, and similar) are recognized as noise and ignored; acting on them is a possible future feature.

---

## 11. Current Status

- **Running live.** Both processes are online under pm2. `CTRADER_HOST` is `live.ctraderapi.com` and the account authenticates successfully (account id 47643988), so this is a live, funded account, not demo.
- **Account size and balance.** Balance started at 10,000 USD and is currently around 10,474 USD, consistent with a roughly 10k funded account (the InstantFunding rules the recent features target). The configured limits fit that size: 300 dollar daily loss, 360 dollar profit cap, 120 dollar combined per-trade-idea risk, 50 dollar per trade.
- **Actively trading.** Recent fills span XAUUSD, BTCUSD, and XAGUSD, with individual closed trades around plus or minus 50 to 68 dollars, in line with the 50 dollar per-trade risk. Both winning and losing days are visible in the realized P&L log.
- **Risk controls have fired in production.** The profit cap and daily loss lock have both triggered. Note two cautionary historical events: the daily loss limit was breached well beyond its threshold on at least one occasion (about minus 622 dollars versus a 300 dollar limit), and the profit cap once realized about 340 dollars against a 300 dollar cap. These indicate the force-close protections, while functional, are not guaranteed to hold the exact limit during fast moves or simultaneous position swings.
- **Stability.** The main bot and channel listener have been restarting cleanly and recovering. The channel listener recently had a series of issues (a zombie connection, then a channel update desync) that were addressed with a liveness watchdog and the 15-second polling fallback.

### Readiness assessment (summary judgement)

DoochyBot is feature-complete for live funded operation: it executes both signal sources, sizes by risk, and enforces daily loss, profit cap, combined per-trade-idea risk, and re-entry cooldown rules, all configurable from Telegram, and it is already running on a live 10k account in profit. The open concerns before fully trusting it unattended on a funded account are: the demonstrated ability of the daily loss force-close to overshoot its limit in fast markets, the loss of cooldown and lock state across restarts, and the SL-confirmation ambiguity. Validating those three under live conditions is the recommended next step.
