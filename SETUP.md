# DoochyBot: local agent setup

DoochyBot trades your own cTrader account from your own machine. Telegram
commands and the mini-app talk to a central hub; the hub relays them to the
DoochyBot running on your PC.

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- cTrader account
- Telegram account whitelisted by the hub owner

## Get your cTrader API credentials (5 minutes, once)

1. Go to https://openapi.ctrader.com/apps and press "Add new app" (any name).
   Wait until it shows as Active.
2. Press "Credentials" next to your app: copy the Client ID and Client Secret.
3. On the same page, generate tokens for your cTrader ID and approve access to
   your trading account: copy the Access token and Refresh token.

Those four values are everything the setup wizard asks for; it finds your
trading account automatically from them.

## Install and set up

```
git clone <repo url>
cd doochybot
pnpm go
```

`pnpm go` installs everything and runs the setup wizard. It asks for a pairing code: send /pair to @DoochyBot in Telegram and type the 6 character code at the prompt.


After that, starting is always just:

```
pnpm doochybot:start
```

## Use it

Everything happens in Telegram via @DoochyBot: /status, /positions, /risk,
/pause, /resume, /closeall, /help for the full list. Set your risk before
starting: ```/risk pertrade 25```


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
- CANT_ROUTE_REQUEST at startup: wrong CTRADER_HOST for your account type
  (demo vs live).
- "Saved token rejected": you were re-paired or removed; get a fresh code with
  /pair and start with --code again.