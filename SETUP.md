# DoochyBot: local agent setup

DoochyBot trades your own cTrader account(s) from your own machine. Telegram
commands and the mini-app talk to a central hub; the hub relays them to the
DoochyBot running on your PC. A single DoochyBot can trade several accounts,
including a mix of demo and live, side by side.

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- cTrader account
- Telegram account whitelisted by the hub owner

## Get your cTrader API credentials (5 minutes, once)

1. Go to https://openapi.ctrader.com/apps and press "Add new app" (any name).
   Wait until it shows as Active.
2. Press "Credentials" next to your app: copy the Client ID and Client Secret.
3. On the same page, generate the access/refresh token pair for your cTrader ID
   and approve access to your trading account(s): copy the Access token and
   Refresh token. ONE pair works for all your demo AND live accounts — do not
   generate a second pair, it invalidates the first.

Those few values are everything the setup wizard asks for; it finds your
trading account(s) automatically from them and asks which one(s) to trade.

## Install and set up

```
git clone <repo url>
cd doochybot
pnpm go
```

`pnpm go` installs everything and runs the setup wizard. It asks for the /pair
code last: send /pair to @DoochyBot in Telegram and type the 6 character code at
the prompt (letters A–Z and digits 2–9), or start later with
`pnpm doochybot:start` and it will ask again.

The wizard's "Which account(s)" prompt lists every account on your cTrader ID.
Pick one for a single-account bot, or several as comma-separated numbers (e.g.
`1,3`). If a picked account is LIVE the wizard uses the live environment for it
automatically — no demo/live questions. Multiple accounts, or a demo+live mix,
get the `CTRADER_CREDENTIALS` + `CTRADER_ACCOUNTS` format (see the "Trading one
or more accounts" section of README.md); a single account gets the flat
`ACCOUNT_ID` form.


After that, starting is always just:

```
pnpm doochybot:start
```

## Use it

Everything happens in Telegram via @DoochyBot: /status, /positions, /risk,
/pause, /resume, /closeall, /help for the full list. Set your risk before
starting: ```/risk pertrade 25```

With several accounts, /status and /positions show every account (summed
headline plus a line per account). To work on one account at a time, open the
mini-app from the hamburger menu → **Open App** and use the account selector at
the top — it scopes everything (balance, positions, orders, trade tab, chart) to
that account. Telegram's /order-style manual commands are also available from the
app's Trade tab.


## Keep it running

Your DoochyBot only trades while your machine is on and the process is
running. If the PC sleeps, nothing manages new signals until it wakes (open
positions keep their broker-side SL/TP). To run it under pm2 so it survives
reboots:

```
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## Troubleshooting

- "Your agent is offline" in Telegram: the process is not running or has no
  internet. Start and retry.
- CANT_ROUTE_REQUEST at startup: environment/account mismatch. With a single
  account your `CTRADER_HOST` must match demo vs live (see `.env`); with
  `CTRADER_ACCOUNTS` each entry must carry the right `env`.
- "Saved token rejected": you were re-paired or removed; get a fresh code with
  /pair and start with --code again.