# DoochyBot

Telegram controlled cTrader auto trader. Every user runs their own DoochyBot on their machine, trading their own cTrader account (demo or live). A central hub connects them all to: one Telegram bot (@DoochyBot), the mini app, and the shared signal sources. Signals go through each user's own risk gate before any order is placed.

```
Telegram + mini-app
        |
       HUB (VPS): relay, pairing, user whitelist
        |  WebSocket
   +----+--------------------+
   |                         |
 your DoochyBot        friend's DoochyBot
 (your machine,        (their machine,
  your account)         their account)
```

**Signal sources:**
- A signal feed, polled by each DoochyBot
- A Telegram channel listener (server side only) that reads set channels; the hub sends its signals out to all connected users.

**How to run DoochyBot as a user:**
- Read [SETUP.md](SETUP.md)
- Short version: clone, `cd doochybot`, `pnpm go`, then pair with a code from /pair.



The agent, channel-listener, and `webapp/` are all pnpm workspace packages, so a
single root `pnpm install` installs every dep (including the webapp's React/Vite
toolchain) and `pnpm build` builds every package. A fresh full-stack machine is
just `pnpm install && pnpm build`; a user setting up their own agent runs
`pnpm go` (see [SETUP.md](SETUP.md)).

### Deploy and gotchas (read me, future self)

- **pm2 runs the compiled `dist/`.** After any code change you MUST rebuild before restarting. `pnpm build` now builds the whole workspace (agent, channel-listener, and the webapp the hub serves), so one build covers everything:
  ```bash
  pnpm build && pm2 restart hub doochybot
  ```
- **The channel listener is a separate pm2 process** (its own folder, `channel-listener/dist`). `pnpm build` at the root already compiles it; just restart it after a rebuild if it changed:
  ```bash
  pm2 restart channel-listener
  ```
- **The host must match the account type.** Use `CTRADER_HOST=demo.ctraderapi.com` for a demo account and `live.ctraderapi.com` for a live one. If they mismatch, app auth still succeeds but account auth fails with `CANT_ROUTE_REQUEST` and the bot crash-loops. Going live needs real live credentials, not just a host change.
- **Public routing:** nginx serves doochy.route07.com and forwards /app, /api and /ws to the hub on 127.0.0.1:9009. /webhook is loopback-only on purpose.

---

## Getting started (trading)

The bot will not place any trade until you set a per-trade risk. The quickest path:

```
/risk pertrade 50      # max $ you lose if a trade's stop is hit
/symbols add XAUUSD    # choose what to trade
/resume                # make sure trading is active
/status                # confirm everything looks right
```

SL and TP come from each signal itself; the bot sizes the trade so a stop hit loses about your pertrade amount. Send `/guide` any time for the full walkthrough.

---

## Telegram Commands

Only whitelisted users (the hub's user list) may issue commands. Trading commands are answered by YOUR DoochyBot; if it is offline you are told so.

### Hub

| Command | Description |
|---------|-------------|
| `/pair` | Get a one-time code to link your local DoochyBot |
| `/adduser <id> [name]` | Whitelist a new user (owner only) |

### Trading control

| Command | Description |
|---------|-------------|
| `/guide` | Step-by-step setup walkthrough |
| `/pause` | Stop executing signals |
| `/resume` | Resume executing signals (also clears a daily-limit lock) |
| `/closeall` | Close all open positions immediately |

### Symbols

| Command | Description |
|---------|-------------|
| `/symbols` | List allowed symbols |
| `/symbols add <SYM>` | Add a symbol to the allowed list |
| `/symbols add all` | Add all feed symbols with confidence at least 3 |
| `/symbols remove <SYM>` | Remove a symbol |
| `/symbols reset` | Restore default list (`BTCUSD, XAUUSD, XAGUSD`) |

### Risk and sizing

| Command | Description |
|---------|-------------|
| `/risk pertrade <usd>` | Max $ you lose if a trade's stop is hit. The bot sizes each trade to match. Required to trade (`0` = trading off). SL/TP themselves come from the signal. |
| `/risk maxpos <n>` | Max concurrent open positions (default `3`). |
| `/minhold <secs>` | Seconds to hold a position before the TP is set (default `60`; `0` = immediate). |

### Daily limits

| Command | Description |
|---------|-------------|
| `/risk maxloss <usd>` | Daily loss limit in $; force-closes everything and stops for the day (default `200`). |
| `/risk cap <usd>` | Daily profit cap: force-closes all positions and blocks new signals once realized + floating P&L reaches this value. `0` = off. |
| `/risk capbuffer <usd>` | Trigger the cap this many $ early so a sub-second price move cannot carry you past it. Recommended: 5 to 10% of the cap. |

### Cooldowns and prop-firm compliance

| Command | Description |
|---------|-------------|
| `/risk losses <n>` | SL hits on one symbol within the window that trigger a cooldown. `0` = off (default `3`). |
| `/risk losswindow <min>` | Rolling window for counting SL hits (default `60`). |
| `/risk cooldown <min>` | How long a symbol is paused after the streak (default `120`). |
| `/risk reentry <min>` | After a losing close, block reopening the same symbol and direction for this long (the same-trade-idea rule). `0` = off (default `10`). |
| `/risk combined <usd>` | Cap the summed risk of all open positions in the same symbol and direction (the per-trade-idea limit). `0` = off. |
| `/cooldown` | List symbols currently in cooldown with time remaining |
| `/cooldown reset [sym]` | Clear a symbol's cooldown, or all cooldowns |

### Monitoring

| Command | Description |
|---------|-------------|
| `/status` | Connection health, balance, trading state, realized + floating P&L, profit cap progress, sizing, cooldowns |
| `/settings` | Show all your configured settings |
| `/positions` | Open positions: direction, symbol, lots, entry, mark price, SL, TP, P&L |

### History

| Command | Description |
|---------|-------------|
| `/export [from] [to]` | Export trade history as a file |

```
/export                               last 7 days
/export 2026-06-01                    from June 1st to now
/export 2026-06-01 2026-06-05         date range
/export 2026-06-01_00:00 2026-06-05_23:59   with time
```

---

## How it works

### Sizing

Trade size is risk-based. You set `pertrade` (the dollars you are willing to lose if the stop is hit) and `sl` (how far the stop sits from entry). The bot then picks the position size so that hitting the stop loses about that many dollars, whatever the symbol or price. A tighter stop means a bigger position; a wider stop means a smaller one. There is no fixed lot size: if `pertrade` is `0`, the bot does not trade.

### What happens to a signal

Every signal, from either source, goes through the same checks before an order is placed, in order: trading not paused, no re-entry cooldown on this symbol and direction, the combined-risk limit not exceeded, the symbol is allowed, no consecutive-loss cooldown on it, only one position per symbol, under the max-positions limit, and within the daily limits. If it passes, the order goes in and the stop loss and take profit are attached (the take profit is set after the min-hold delay).

### Market and limit orders

Feed signals, and channel signals without a price level, are market orders filled immediately. A channel signal that says LIMIT is placed as a resting limit order at the given price, good-till-cancel, with its stop loss and take profit attached to the order so it stays protected even if the bot restarts before it fills.

### Daily loss limit

The daily loss limit both blocks new signals and, through a one-second monitor, force-closes all open positions the moment realized plus floating loss reaches the limit. It waits for a brief confirmation and for live prices on every position before acting, so a momentary spike does not liquidate everything.

### Daily profit cap

Optional, for prop-firm-style profit targets. Once your realized + floating profit reaches the cap, the bot force-closes all positions and stops taking new signals for the rest of the day. It reacts within about a second, and also places a backup target at the broker in case the bot itself is down. Set a small `capbuffer` so a sudden spike cannot carry you past the cap.

Example for a $400 cap:
```
/risk cap 400
/risk capbuffer 20
```

### Prop-firm trade-idea rules

Two controls keep the account inside per-trade-idea risk rules (for example InstantFunding). A trade idea is one symbol in one direction; the opposite direction is a separate idea.

- **Re-entry cooldown** (`/risk reentry`): after any losing close, reopening the same symbol and direction is blocked for the window, so a quick loss-then-reopen is not treated as one oversized idea.
- **Combined risk limit** (`/risk combined`): the summed potential loss of all open positions in the same symbol and direction is capped, so stacking positions cannot exceed the per-idea risk.

### Surviving restarts

Active cooldowns (both kinds) and the daily-limit lock are saved to `data/settings.json` and restored on startup, so a restart does not silently clear a cooldown or unlock the account. Time-based cooldowns are only restored if still active, and the lock only if it was set the same day. Open positions and today's realized P&L are re-read from the broker on startup.

### Stop-loss safety net

Every 60 seconds the bot asks the broker for the real stop loss on each open position and re-sends the amendment for any position that has none, as a backstop against a stop loss that failed to attach.

---

## Environment variables

`.env` (every DoochyBot, see `.env.example`; the setup wizard writes this):

| Variable | Description |
|----------|-------------|
| `CTRADER_HOST` | `demo.ctraderapi.com` or `live.ctraderapi.com` (must match the account) |
| `CTRADER_PORT` | `5035` |
| `CLIENT_ID` | Your own cTrader Open API app's client ID |
| `CLIENT_SECRET` | Your own cTrader Open API app's client secret |
| `ACCESS_TOKEN` | OAuth access token for your account |
| `REFRESH_TOKEN` | OAuth refresh token |
| `ACCOUNT_ID` | Internal ctidTraderAccountId (the wizard finds it) |
| `HUB_WS_URL` | `wss://doochy.route07.com/ws` for users; loopback on the VPS |

`.env.hub` (VPS only): `HUB_BOT_TOKEN`, `HUB_PORT`, `WEBHOOK_SECRET`. The old `TELEGRAM_BOT_TOKEN`/`ALLOWED_USERS`/`WEBHOOK_SECRET` entries in the VPS `.env` exist only for the retired legacy entrypoint.

The channel listener has its own `channel-listener/.env` and runs only on the VPS with the owner's Telegram session.
