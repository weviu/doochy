# 📊 Multi-Asset Scanner with Position Sizing

A professional-grade cryptocurrency, metals, and index scanner powered by pm2, designed for
Breakout Prop and similar prop firm trading environments. Each scanner publishes signals to a
shared JSON feed consumed by an external executor (**doochybot**, separate repo) — this repo is
the **signal + feed** side only.

---

## 📁 Repository Structure

```
crypto-scanner/
├── scanner.py              # Crypto scanner (Binance) — Nadaraya-Watson mean-reversion, all timeframes via CLI
├── gold-scanner.py         # Gold (XAUUSD, cTrader) — 1h-sourced multi-strategy (cloud pullback / Asian breakout / RSI2)
├── gold-15m-scanner.py     # Gold (XAUUSD, cTrader) — short-term companion: donchian momentum + VWAP-reclaim SELL
├── silver-scanner.py       # Silver (XAGUSD, cTrader) — wick-rejection sweep fade + RSI2 time-exit
├── us100-scanner.py        # NASDAQ-100 (US100, cTrader) — 1h donchian momentum breakout
├── shitnals.py             # Gold (XAUUSD, cTrader) — inverse-signal scanner: detects reliably-wrong retail setups, publishes the opposite
├── ctrader_feed.py         # Shared cTrader Open API client (used by all cTrader-sourced scanners)
├── backtest.py             # Replays the alerts.json feed against Binance history (win rate, R, PF)
├── core/                   # Shared engine: feed contract, guards, health watchdog, trend-following kit, config
├── ecosystem.config.js     # pm2 process definitions (production stack)
├── run.sh                  # One-time pm2 bootstrap (log rotation + start)
├── data/
│   └── alerts.json         # Signal feed written by the scanners, served on :8880
├── logs/                   # pm2 log files (rotated)
├── docs/                   # Design docs & specs referenced by the live code (hmm.md, FEED_CONTRACT.md, ...)
├── README.md               # This file
└── old/                    # Retired scanners & docs (metals-scanner.py's era, xau/xag-scanner.py, etc.) — not in the stack
```

---

## 🎯 Overview

The production system is a **pm2-managed stack** of independent scanners, each writing to the
same `data/alerts.json` feed (served over HTTP on :8880). doochybot polls that feed and places
orders; scanner-side signal generation and execution are fully decoupled.

| Scanner | Instrument(s) | Source | Base TF | `signal_source` |
|---------|---------------|--------|---------|------------------|
| `scanner.py` | Crypto: BTC, ETH, BCH, BNB | Binance | 1h (`--loop 15`) | `signal_scanner` |
| `gold-scanner.py` | Gold (XAUUSD) | cTrader | 15m scan / 1h-sourced strategies | `gold_scanner` |
| `gold-15m-scanner.py` | Gold (XAUUSD) | cTrader | 15m | `gold_15m_scanner` |
| `silver-scanner.py` | Silver (XAGUSD) | cTrader | 15m | `silver_scanner` |
| `us100-scanner.py` | NASDAQ-100 (US100) | cTrader | 1h | `us100_scanner` |
| `shitnals.py` | Gold (XAUUSD) | cTrader | 1h | `shitnals` |

All metals/index scanners are **independent streams** — each does its own HTF-gating and
confluence, and the feed does not dedupe *across* scanners (only within a scanner, by source bar).
doochybot is responsible for netting overlapping exposure.

> **Quick start (production):** `./run.sh` — boots the whole stack under pm2. See
> [Live Deployment](#-live-deployment-pm2) below.

---

## 📊 Crypto Scanner (`scanner.py`)

### Overview

Scans a hand-picked crypto universe (BTC, ETH, BCH, BNB) across any timeframe from 1m to 1d.
Mean-reversion focused, with Squeeze Momentum, SMRE statistical filters, and built-in Smart Money
Concepts (BOS, CHoCH, Order Blocks, FVGs). Crypto-only — metals and indices are separate scanners
via `ctrader_feed.py` (see below).

### BTC Market State

On every scan, `scanner.py` reads BTC on the higher timeframes (relative to the scan TF) and
buckets the averaged 5- and 10-bar momentum into one of five states:

`STRONG_BULLISH` · `BULLISH` · `NEUTRAL` · `BEARISH` · `STRONG_BEARISH`

This state is **printed for context**, **attached to every crypto signal** in the feed as the
`btc_state` field (metals/index carry `null` — only crypto tracks BTC), and **adjusts crypto
signal confidence** in a direction-aware way.

#### Confidence adjustment

In a bearish BTC regime, longs are faded and shorts are favoured. The deltas (percentage points)
are defined in the `BTC_STATE_CONFIDENCE_ADJ` dict near the top of `scanner.py` and are easily
tunable:

| BTC state | BUY signals | SELL signals |
|-----------|-------------|--------------|
| `STRONG_BEARISH` | −20 | +20 |
| `BEARISH` | −10 | +10 |
| `NEUTRAL` | 0 | 0 |
| `BULLISH` | 0 | 0 |
| `STRONG_BULLISH` | 0 | 0 |

- Applies to **crypto only** — metals/index are never adjusted.
- The delta is **added** to confidence, then clamped to `[0, 100]`. A SELL at 90 in
  `STRONG_BEARISH` becomes 100 (not 110); a BUY at 90 becomes 70.
- After the adjustment, the usual **50% floor** applies — a BUY penalised below 50 is dropped.
- The adjusted confidence also feeds position sizing and take-profit scaling, so a penalised
  signal also gets a smaller position.
- Bullish and neutral states are no-ops; set non-zero values in the dict to change that.

### Features

- **Nadaraya-Watson Envelope** (adaptive bandwidth per timeframe)
- **RSI** for momentum confirmation (period adjusts per timeframe)
- **5 Signal Types**: Crossover, Oversold/Overbought Bounce, Envelope Extreme
- **Crypto universe**: BTC, ETH, BCH, BNB

### Filter System

| Filter / Indicator | Impact | Description |
|--------------------|--------|-------------|
| **Nadaraya-Watson Envelope** | Core | Primary mean-reversion boundary detection |
| **RSI** | Core | Momentum confirmation |
| **Volume** | +6-12% | Confirms unusual trading activity with direction analysis |
| **MA Trend** | +8% or -15% | Aligns signals with trend (MA50 or MA200 depending on TF) |
| **Timeframe Confirmation** | +15% or -15% | Higher/lower timeframe alignment |
| **Squeeze Momentum** | Modifies | Identifies consolidation before breakout |
| **SMRE Statistical Filters** | Modifies | Z-score, Hurst exponent, volatility regime |
| **RSI Divergence** | -20% | Detects RSI/Price mismatches |
| **Price Velocity** | -15% | Filters capitulation/blow-off moves |

### Take-Profit Tightening

The feed's `tp` is **TP1**, the target doochybot executes. Backtesting the feed
([`backtest.py`](#-backtesting-the-feed-backtestpy) `--tp-scale` sweep) showed the original TP1
overshoots — too many trades expire without ever tagging it. `TP1_TIGHTEN_FACTOR` (near the top of
`scanner.py`, default **0.5**) pulls TP1 toward entry for a nearer, more-probable target while
**leaving SL unchanged**:

| Factor | Meaning |
|--------|---------|
| `1.0` | Original TP1 (NW midline / ~0.75% move) |
| `0.5` | Halfway to entry — total realised R peaked here in the sweep |
| `< 0.5` | Tighter still: higher hit-rate, but total R starts to fall |

Trade-off: a nearer TP wins smaller amounts but far more often, converting "never resolved" trades
into completions. Re-run the sweep after tuning to reconfirm on fresh feed data. TP2/TP3 (console
scale-out targets) are unaffected.

### ATR-Scaled Stops & Targets

Stops and TP1 are placed off **ATR** rather than a fixed % (toggle `USE_ATR_LEVELS`, constants near
the top of `scanner.py`). Fixed-% levels ignore the regime — too wide when calm (poor R:R), too tight
when volatile (stopped by noise). ATR levels breathe with volatility:

- **Stop** = `ATR_STOP_MULT` (1.5) × ATR, **clamped to [0.5×, 2×] of the timeframe's legacy %-stop** so
  a near-zero ATR can't create a microscopic stop (→ oversized position).
- **TP1** = `ATR_TP1_MULT` (1.0) × ATR, **capped at the NW mean (`mid`)** — kept deliberately near so it
  is actually *hit*, not "almost hit". TP2/TP3 (2×/3× ATR) are scale-out targets.
- **Automatic de-risking:** since position size = risk / stop-distance, a wider ATR stop *shrinks* size
  when volatility expands — smaller bets on violent days, for free.

### Anti-Breakout & RSI-Continuation Guards

Filters exposed by measuring a real BTC squeeze episode, where the scanner had fired its
highest-confidence SELLs into a vertical breakout (all tunable, defined near the top of
`scanner.py`):

| Guard | Rule | Why |
|-------|------|-----|
| **RSI continuation** | Past `RSI_CONTINUATION_PENALTY_START` (75) the fade is penalised; at `RSI_CONTINUATION_VETO` (82) it's dropped | Fades at RSI 70–78 won ~89%; at 78–85 only 12%; 85+ lost every time. Extreme RSI = momentum, not a top |
| **Adverse impulse** | Veto a fade when price has moved ≥ `FADE_IMPULSE_VETO_ATR` (1.0) ATR **against** it over the last 2 bars | Fading a move already running ≥1 ATR against us lost 100% of the time; a smaller pullback mean-reverts fine |
| **Volatility spike** | Penalise/veto when the latest bar's range ≥ `VOL_SPIKE_VETO_ATR` (3.5) × ATR (non-directional) | Catches violent two-sided bars where reversion is unreliable, even if the net move is small |
| **RSI weight** | Base-confidence RSI slopes flattened (×2→×1.2, ×3→×1.5) | Confidence used to *rise* with RSI — backwards, since extreme RSI is where fades fail |
| **No re-arm** | Skip a same-direction signal that re-enters at an adverse price within `NO_REARM_WINDOW_MIN` (120 min) | Prevents re-shorting the same symbol repeatedly up a rally — averaging into a loser |

The **BTC volatility circuit breaker** (`should_pause_counter_trend` in `scanner.py`) trips on a
single outsized BTC bar (`BTC_VOLATILITY_FAST_BAR_ATR`) and falls back to the latest **impulse
direction** when the smoothed 5/10-bar `price_dir` reads NEUTRAL.

### SMC Features

#### Market Structure Filter

| Structure | BUY Signal Impact | SELL Signal Impact |
|-----------|-------------------|--------------------|
| Bullish (BOS UP) | +10% confidence | -15% confidence |
| Bearish (BOS DOWN) | -15% confidence | +10% confidence |
| Neutral | No adjustment | No adjustment |

#### Order Block Filter
Identifies the last opposing candle before a strong move. Adds +8% confidence if price is in an OB zone.

#### Fair Value Gap Filter
Identifies 3-candle institutional gaps. Adds +10% confidence if price is in an FVG zone.

### Usage

```bash
# Default: 1h timeframe, full crypto universe
python scanner.py

# 15-minute timeframe (day trading)
python scanner.py -tf 15m

# Verbose mode (shows all symbols)
python scanner.py -tf 15m -v

# Custom account size and risk
python scanner.py -tf 30m --account-size 50000 --risk 0.015

# Disable individual filters
python scanner.py --no-squeeze --no-smre --no-smc

# Help
python scanner.py --help
```

### Command-Line Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `-tf, --timeframe` | Timeframe to scan | `1h` |
| `-v, --verbose` | Show all symbols, not just signals | `False` |
| `--list-timeframes` | Print available timeframes and exit | — |
| `--account-size` | Account size in USD | `10000` |
| `--risk` | Risk per trade (decimal, e.g. 0.02 = 2%) | `0.02` |
| `--max-positions` | Max concurrent positions | `3` |
| `--no-squeeze` | Disable Squeeze Momentum filter | `False` |
| `--no-smre` | Disable SMRE Statistical filter | `False` |
| `--no-smc` | Disable Smart Money Concepts filter | `False` |
| `--loop N` | Repeat the scan every N minutes, keeping the process alive (0 = single run) | `0` |

### Timeframe Parameters

| Timeframe | Lookback | Bandwidth | Multiplier | RSI | MA | Risk | Targets |
|-----------|----------|-----------|------------|-----|-----|------|---------|
| **1m-15m** | 200 | 3.5 | 2.0 | 8 | 50 | 1.0% | 1.5%/2.5%/4% |
| **30m** | 300 | 4.5 | 2.5 | 10 | 100 | 1.5% | 2%/3.5%/5% |
| **1h** | 500 | 6.0 | 3.0 | 14 | 200 | 2.0% | 3%/5%/7% |
| **2h** | 500 | 8.0 | 4.0 | 14 | 200 | 2.0% | 4%/7%/10% |
| **4h-6h** | 500 | 7.0 | 3.5 | 14 | 200 | 2.0% | 4%/7%/10% |
| **12h-1d** | 500 | 8.0 | 4.0 | 14 | 200 | 2.0% | 4%/7%/10% |

---

## 🥇 Gold, 🥈 Silver & 💻 Index Scanners (cTrader)

Four independent scanners share `ctrader_feed.py` (the cTrader Open API client) and `core/`
(feed contract, HTF trend/confluence kit, guards, health watchdog). Each was built by the same
process: **backtest a basket of candidate strategies walk-forward, cost-adjusted, and ship only
what clears positive expectancy net of costs** — losing candidates are documented (in code
docstrings and project memory) so they aren't re-tried blindly.

### `gold-scanner.py` — Gold, 1h-sourced multi-strategy

Three strategies combined by confluence, all reading the last **closed 1h bar** regardless of
scan TF (backtesting showed no edge on 15m for the pullback/RSI2 legs):

- **S1 EMA cloud pullback** (`docs/hmm.md`) — EMA34/134 cloud trend + EMA5/8 ribbon resume-cross.
- **S2 Asian-range → London breakout** — 00:00–07:00 UTC range, first close outside during the
  London window.
- **S3 Connors RSI(2) pullback** — dip fade vs SMA200, with a validated time-based exit.

4h EMA-cloud align/oppose adjusts confidence; a session gate blocks the COMEX-settle dead hour and
penalises quiet Asian hours. See the module docstring in `gold-scanner.py` for backtest citations.

### `gold-15m-scanner.py` — Gold, short-term companion

A deliberately higher-frequency, lower-conviction 15m stream (independent `signal_source` — no
cross-scanner dedupe with `gold-scanner.py`; doochybot nets exposure). Two strategies, both
HTF-cloud-gated:

- **Donchian momentum breakout** (4h+1h gated) — the stronger, symmetric edge.
- **VWAP reclaim, SELL-only** — the backtested BUY side was flat, so only the validated short side ships.

### `silver-scanner.py` — Silver

- **S1 wick-rejection sweep fade** — failed stop-hunt against the 4h/134-cloud trend.
- **S2 Connors RSI(2)** — same family as gold's S3, with a time-based exit.

### `us100-scanner.py` — NASDAQ-100

A single validated strategy: **1h donchian-60 momentum breakout, hard-gated to both the 4h and 1d
cloud**. A 15m version was tested first and rejected — it backtested as long-only bull-beta with
no validated short side; the 1h version, backtested over ~2.2 years spanning real drawdowns,
holds up across all three regime-thirds.

### `shitnals.py` — Gold, inverse-signal scanner

Built backwards on purpose: a basket of deliberately-bad retail strategies was backtested across
XAU/XAG/US100/BTC/ETH (1h + 15m) looking for setups so *reliably* wrong that trading their exact
opposite is an edge. Most bad strategies are **not** invertible — they lose to costs and chop in
both directions (all of crypto and all of silver failed this way). Two gold-1h setups survived
every robustness check on the inverted side; the scanner detects the wrong trade (the "shitnal")
and **publishes its exact mirror to the feed** — opposite direction at the same entry, with the
shitnal's SL and TP levels swapped (shitnal BUY @4100 sl 4080 tp 4120 → published SELL @4100
sl 4120 tp 4080). Inversion happens inside the scanner; doochybot executes the feed as-is:

- **W1 breakout fade** — retail fades a fresh with-cloud 60-bar breakout → shitnals joins it
  (mirror +0.12 avgR, 65% win vs 57% breakeven, positive in all regime-thirds and every year).
- **W2 knife catch** — retail buys an RSI(2) < 5 crash below SMA200 (or shorts > 95 above it) →
  shitnals trades the continuation (mirror +0.089 avgR, positive both halves, every year).

See the module docstring for the full backtest citations, caveats, and the rejected
not-invertible basket. New scanner — pm2 entry ships commented out pending go-live.

### Usage

```bash
python gold-scanner.py -tf 15m -v
python gold-15m-scanner.py --loop 5
python silver-scanner.py -tf 15m
python us100-scanner.py -tf 1h --loop 15
python shitnals.py -v --loop 15
```

---

## 📦 Installation

```bash
git clone <this repo>
cd crypto-scanner
pip install ccxt pandas numpy
```

The scanners run standalone with just the Python dependencies above. For the production stack you
also need **Node.js + pm2** (`npm install -g pm2`), and for the cTrader-sourced scanners
(gold/silver/US100), cTrader Open API credentials in `.env` (see `ctrader_feed.py`).

---

## 🚀 Live Deployment (pm2)

The production stack runs under [pm2](https://pm2.keymetrics.io/) and is defined in
`ecosystem.config.js`:

| Process | Command | Purpose |
|---------|---------|---------|
| `signal-scanner` | `scanner.py -tf 1h --loop 15` | Crypto scan (1h, 4h-confirmed), writes the feed |
| `gold-scanner` | `gold-scanner.py -tf 15m --loop 5` | Gold multi-strategy (cTrader) |
| `gold-15m-scanner` | `gold-15m-scanner.py -tf 15m --loop 5` | Gold short-term companion (cTrader) |
| `silver-scanner` | `silver-scanner.py -tf 15m --loop 15` | Silver (cTrader) |
| `us100-scanner` | `us100-scanner.py -tf 1h --loop 15` | NASDAQ-100 momentum breakout (cTrader) |
| `feed-server` | `python -m http.server 8880` (in `data/`) | Serves `alerts.json` over HTTP on **:8880** |

Each scanner uses its built-in `--loop`, so the processes stay **continuously online** (no cron
restarts, no "stopped" flapping) and the loop sleeps to the next wall-clock boundary.

### First-time setup

```bash
./run.sh
```

`run.sh` installs and configures the **pm2-logrotate** module (caps each log at 10 MB, keeps 5
rotated + gzipped files), then starts the stack and saves it. After that, day-to-day you only need:

```bash
pm2 start ecosystem.config.js   # start the stack
pm2 logs gold-scanner           # tail a scanner's logs (logs/gold-scanner.log)
pm2 restart gold-scanner        # apply code changes (the loop holds code in memory)
pm2 save                        # persist the process list
pm2 resurrect                   # restore the saved stack after a reboot
```

> **Note:** because each scanner runs a resident `--loop`, code edits are only picked up after a
> `pm2 restart <name>`.

---

## 📡 Signal Feed (`data/alerts.json`)

Every scan appends its signals to `data/alerts.json` (newest first, capped at 500 entries),
written atomically by `core/feed.py` and served by `feed-server` on port **8880**. Each entry:

```json
{
  "timestamp": "2026-06-30 14:15:36",
  "symbol": "TIAUSD",
  "timeframe": "30m",
  "direction": "buy",
  "rsi": 27.47,
  "price": 0.3636,
  "pivot_level": null,
  "pivot_distance": null,
  "confidence": 60.6,
  "sl": 0.3552,
  "tp": 0.3647,
  "time_exit_min": null,
  "src_bar": null,
  "btc_state": "STRONG_BEARISH",
  "signal_source": "signal_scanner"
}
```

- **Symbols** are normalised to `<BASE>USD` (e.g. `TIA/USDT` → `TIAUSD`, `XAU/USDT:USDT` → `XAUUSD`).
- **`btc_state`** carries the current BTC market state for **crypto** signals only; metals/index
  carry `null`.
- **`src_bar`** (closed source-bar UTC timestamp) is the feed's dedupe key for scanners whose
  strategies re-anchor stop/TP to live spot on a slower source timeframe — the same underlying
  signal would otherwise re-fire at a different price on every scan loop until the source bar
  rolls. Dedupe is per-`signal_source`; it does not dedupe across different scanners.
- **`time_exit_min`**, when set, tells doochybot to close the position at market this many minutes
  after fill (SL stays armed) — used by the Connors RSI(2) time-based exit.

---

## 🧪 Backtesting the Feed (`backtest.py`)

Replays every signal in `data/alerts.json` against historical OHLCV pulled from Binance (the same
source `scanner.py` uses) and reports how the `direction` / `price` / `sl` / `tp` levels would have
played out — **win rate, R-multiple, expectancy, and profit factor**, broken down by direction and
symbol. (For the cTrader-sourced scanners — gold/silver/US100 — this feed replay isn't applicable;
those are validated instead by ad-hoc walk-forward backtests against `ctrader_feed.py` history, one
per scanner, documented in each scanner's module docstring.)

### Entry model

Mirrors the feed → execution contract (`price` is a **target level**, not a market fill):

- **`target`** *(default)* — a trade is only taken if price trades **through** the `price` level
  within `--entry-window` bars (default 3, matching doochybot's `staleOrderBars`); orders that
  never fill are reported as **no-fill** and excluded, exactly like a stale resting order expiring.
- **`market`** — fill at the next candle's open instead (`--entry-mode market`).

### Resolution

From the entry candle, walk forward until **TP or SL** is touched, or `--max-bars` elapses. If a
single candle spans **both** levels, SL is assumed to fill first (conservative — intrabar order is
unknown). Unresolved trades are split into:

- **open** — held the full `--max-bars` without hitting a level, and
- **pending** — not enough history exists *yet* (the signal is too recent to judge fairly).

### Usage

```bash
# Default: target entry, 3-bar fill window, 192-bar (48h on 15m) max hold
python3 backtest.py

# Fill at market instead of at the target level
python3 backtest.py --entry-mode market

# Shorter hold, only high-confidence signal_scanner alerts
python3 backtest.py --max-bars 40 --source signal_scanner --min-conf 60

# One symbol, dump per-trade detail to JSON
python3 backtest.py --symbol BTCUSD --json-out results.json
```

### De-duplication (important for accuracy)

A scanner can re-fire the *same setup* every scan cycle while conditions persist, so one
opportunity can appear as a dozen near-identical alerts (same symbol/direction, entry within a
fraction of a percent). **doochybot rejects these duplicates live** (it already holds the
position), so counting each one in the backtest badly inflates the results — e.g. a single
BCHUSD BUY that re-fired 9× would otherwise score as 9 separate wins.

The backtester collapses them: any run of same `(symbol, direction, timeframe)` alerts within
`--dedup-window` bars of the first is treated as **one trade**, keeping the highest-confidence
alert in the cluster (the rest are dropped). Set `--dedup-window 0` to disable and see the raw
per-alert count. Use `-v` to print exactly which alerts were collapsed.

### Command-Line Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `--alerts` | Path to the alerts feed | `data/alerts.json` |
| `--entry-mode` | `target` (fill only if `price` is reached) or `market` (next open) | `target` |
| `--entry-window` | Bars to wait for a target fill | `3` |
| `--max-bars` | Max bars to hold before marking a trade open | `192` |
| `--dedup-window` | Collapse same-setup re-fires within this many bars into one trade (0 disables) | `4` |
| `--source` | Only backtest alerts from this `signal_source` | all |
| `--symbol` | Only this alert symbol (e.g. `BTCUSD`) | all |
| `--min-conf` | Minimum confidence filter | — |
| `--json-out` | Write per-trade results to this JSON file | — |
| `-v, --verbose` | Print each de-duplicated signal | `False` |

> **Note:** alert timestamps are parsed as **UTC** (matching the scanner/feed
> convention). Results are only meaningful once `alerts.json` has accumulated enough post-signal
> history — a fresh feed will show mostly `pending` trades.

---

## 📈 Signal Types (`scanner.py`)

| Signal | Condition | Description |
|--------|-----------|-------------|
| **BUY_CROSS** | Price crosses above lower band + RSI < 45-50 | Bullish reversal confirmed |
| **SELL_CROSS** | Price crosses below upper band + RSI > 50-55 | Bearish reversal confirmed |
| **BUY_OVERSOLD** | RSI < 30-35 + Price near lower band | Oversold bounce opportunity |
| **SELL_OVERBOUGHT** | RSI > 65-70 + Price near upper band | Overbought drop opportunity |
| **BUY_EXTREME** | Price > 1.5-2% below lower band | Capitulation level |
| **SELL_EXTREME** | Price > 1.5-2% above upper band | Exhaustion level |

The gold/silver/US100 scanners use different strategy families entirely (trend/momentum, not
Nadaraya-Watson mean-reversion) — see their module docstrings for signal conditions.

---

## 🧪 Supported Assets

| Scanner | Assets | Source |
|---------|--------|--------|
| `scanner.py` | BTC, ETH, BCH, BNB — edit `SPOT_SYMBOLS` near the top to change it | Binance |
| `gold-scanner.py` / `gold-15m-scanner.py` / `shitnals.py` | XAUUSD (Gold) | cTrader |
| `silver-scanner.py` | XAGUSD (Silver) | cTrader |
| `us100-scanner.py` | US100 (NASDAQ-100) | cTrader |

---

## 🔧 Troubleshooting

### Issue: "Insufficient data" for gold/silver/US100
**Solution**: These are fetched from **cTrader** (via `ctrader_feed.py`), not Binance. Check the
cTrader connection / `.env` credentials if data is missing. Note the feed's retention differs by
timeframe: ~7 months for TFs ≤15m, ~2.2 years for 1h; 4h/1d error on very large `count` requests.

### Issue: Rate limit errors
**Solution**: The Binance scanner (`scanner.py`) uses `enableRateLimit: True`. Reduce scan frequency if errors persist.

### Issue: No signals detected
**Solution**:
- Try a different timeframe
- Use `-v` to see all symbols (including near-miss signals)
- In trending markets, a small crypto universe can legitimately be quiet — widen `SPOT_SYMBOLS` if you want more flow
- For the cTrader scanners, most strategies are hard-gated to a higher-timeframe cloud — a quiet
  period there means the gate is (correctly) closed, not that the scanner is broken. Check
  `scanner_health.json` / pm2 logs to rule out a feed outage.

### Issue: Too many signals
**Solution**:
- Raise `--min-conf` (e.g. `--min-conf 65`)
- Use a longer timeframe

---

## 📊 Version History

| Version | File | Changes |
|---------|------|---------|
| **v7.1** | `shitnals.py` | New gold inverse-signal scanner: backtested a basket of deliberately-bad retail strategies across 5 instruments and 2 TFs, kept the two whose inverses passed every robustness check (inverse breakout-fade +0.12 avgR, inverse knife-catch +0.089 avgR, gold 1h), publishes the mirror of each detected shitnal (opposite direction, SL/TP swapped). Everything on silver and crypto proved non-invertible (both sides lose). Ships commented out in pm2 pending go-live |
| **v7.0** | `us100-scanner.py` | New NASDAQ-100 scanner: 1h donchian momentum breakout, hard 4h+1d cloud gate. A 15m version was backtested first and rejected (long-only bull-beta, no validated short side); the 1h version was validated over ~2.2 years spanning real drawdowns, positive in every regime-third |
| **v6.1** | `gold-15m-scanner.py` | New short-term gold companion: donchian momentum breakout (4h+1h gated) + VWAP-reclaim (SELL-only — the backtested BUY side was flat). Independent feed stream from `gold-scanner.py` |
| **v6.0** | `gold-scanner.py`, `silver-scanner.py`, `core/health.py`, `core/feed.py` | Zero-signal-day post-mortem: found a silent cTrader auth outage + two structurally-dead strategies. Shipped a health watchdog (`core/health.py`, alarms after 3 consecutive scan failures) and `src_bar` feed dedupe (fixes re-anchored 1h-sourced signals writing duplicate entries at drifting prices). S1 (cloud pullback) moved from 15m to 1h source (no edge on 15m, `+0.52` avgR aligned on 1h); S2's Asian-range cap raised 1.20%→2.50% (backtest-validated) |
| **v5.7** | `silver-scanner.py` | New silver scanner (cTrader, XAGUSD): wick-rejection sweep fade (cloud-trend-filtered) + Connors RSI(2) with a time-based exit |
| **v5.6** | `gold-scanner.py`, `core/trend.py` | New multi-strategy gold scanner (cTrader, XAUUSD): EMA-cloud pullback, Asian-range→London breakout, Connors RSI(2), combined by confluence with a 4h HTF align/oppose adjustment. `core/trend.py` extracted as a shared trend-following kit |
| **v5.5** | — | Parity port of the July anti-breakout hardening into a since-retired metals scanner (see `old/docs/` for the historical write-up) |
| **v5.4** | `scanner.py` | ATR-scaled stops & targets: stop = 1.5×ATR clamped to [0.5×,2×] the legacy %-stop; TP1 = 1×ATR capped at the NW mean (near → actually hit, "not almost hit"); position size auto-shrinks on volatility expansion. Per-symbol volatility-spike guard |
| **v5.3** | `scanner.py` | Squeeze post-mortem: anti-breakout guards — RSI-continuation penalty/veto (extreme RSI = momentum, not a top), ATR-normalised adverse-impulse veto (don't fade a running breakout), hardened BTC volatility breaker (fast single-bar trigger + impulse-direction fallback), no-re-arm guard (stop averaging into a fade). Production TF moved to **1h + loop 15m with 4h confirmation** |
| **v5.2** | `scanner.py` | `TP1_TIGHTEN_FACTOR` (default 0.5): pulls the published TP1 toward entry for a nearer, more-probable target (SL unchanged) |
| **v5.1** | `backtest.py` | Feed backtester: replays `alerts.json` against Binance history; target/market entry models; TP/SL resolution with conservative same-candle handling; win rate / R / expectancy / profit factor by direction and symbol; open vs pending split |
| **v5.0** | stack | pm2 production stack (`ecosystem.config.js` + `run.sh`); `scanner.py` `--loop` mode (always-on, wall-clock aligned); BTC market state attached to crypto signals (`btc_state`); direction-aware BTC-state confidence adjustment; `feed-server` on :8880; log rotation |
| **v3.1** | `scanner.py` | Bug fixes: Wilder's RSI smoothing, corrected Hurst exponent, squeeze release logic, BUY_/SELL_ extreme signal prefixes, directional HTF confirmation, USDT symbol normalisation, UTC timestamp |
| **v3.0** | `scanner.py` | Unified scanner with CLI arguments, 3 TP targets, enhanced filters |
| **v2.0** | `scanner.py` | Short-term version added (5m-30m) |
| **v1.0** | `scanner.py` | Long-term version (1H) |

Older, now-retired scanners (a BTC-only intraday scanner, and an earlier metals/gold-momentum pair)
are summarised in `old/docs/` for historical reference; none are part of the current stack.

---

## 📝 License

This project is for educational purposes only and is provided under the MIT License. Trading involves significant risk.

---

## 🙏 Acknowledgements

- **LuxAlgo** for the original Nadaraya-Watson Envelope indicator
- **ccxt** for exchange connectivity
- **Breakout Prop** for the symbol list

---

## 🚀 Next Steps

1. **Telegram Alerts**: Push notifications when signals appear
2. **Auto-Execution**: Connect to Binance API for automated trading
3. **Web Dashboard**: Visualise signals and performance
4. **Multi-Timeframe Confluence**: Combine 15m + 30m signals for higher-conviction entries

---

**Happy Scanning! 📊**
