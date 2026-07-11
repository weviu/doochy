# Configurable Settings & Signal Weights (`scanner.config` tuning)

Making every tunable knob in the scanner stack — bot params, indicator params, guard
thresholds, the BTC-regime engine, and the per-filter **signal weights** — overridable
from a dedicated `scanner.config` file, so settings can be tuned without editing code.
Groundwork for the "tune up settings" pass.

> **Where settings live.** `scanner.config` (repo root) holds only the overrides you set —
> it is *not* "the config". The **defaults are the source of truth, baked into the code**
> as `config.get_*("KEY", <default>)`. An absent/all-commented `scanner.config` → every
> scanner runs on code defaults. `.env` is left untouched, holding only cTrader credentials.
> `scanner.config` has no secrets, so it is version-controlled (tuning history is tracked).

## Principles

- **Behaviour-preserving.** Every setting becomes `config.get_*("KEY", <today's value>)`.
  With an empty/absent `scanner.config`, every getter returns the code default, which is
  today's hard-coded value — so **nothing changes until a key is set**. Each phase is
  verified against the equivalence harnesses (feed / indicators / guards / strategy /
  regime): no override → byte-identical output.
- **Resolution order** (highest priority first): shell env var → `scanner.config` → code
  default.
- **Per-scanner namespacing.** Each scanner process sets `SCANNER_ROLE`
  (`crypto` / `metals` / `xau`) in `ecosystem.config.js`. A lookup for `KEY` tries
  `<ROLE>_KEY` first, then bare `KEY`, then the default. So `CRYPTO_VOL_SPIKE_VETO_ATR`
  tunes only the crypto scanner, while `VOL_SPIKE_VETO_ATR` applies to all three. Run a
  scanner outside pm2 (no role) → only bare keys apply.
- **Separation of concerns.** `.env` = cTrader secrets (read by `ctrader_feed.py`);
  `scanner.config` = all tuning (read by `core/config.py`). They never share keys.

## The config loader — `core/config.py`

One small loader (hand-rolled `KEY=value` parser; no new dependency). Reads
`scanner.config` once at import, plus `os.environ`. The path is overridable via the
`SCANNER_CONFIG` env var (used by tests). Typed getters, all `(KEY, default)`:

| getter | notes |
|---|---|
| `get_float` / `get_int` | numeric; bad value → default |
| `get_bool` | `1/true/yes/on` → True |
| `get_str` | raw string |
| `get_list` | comma-separated → list |

Inline comments in values are stripped (`KEY=3.5  # note` → `3.5`). `scanner.config` ships
fully commented, showing every key + its default (74 keys, grouped A–G).

## What each scanner keeps vs shares

Core modules (`config`, `guards`, `strategy`, `indicators`, `feed`) are imported by the
crypto and metals scanners; `xau-scanner.py` (momentum) uses only `config` + `feed` and
keeps its own indicators. The role prefix means the same shared constant can take
different values per scanner process.

---

## Phases

### Phase 1 — config loader + role wiring ✅
- Added `core/config.py` (precedence, role prefixing, typed getters).
- Wired `SCANNER_ROLE` into `ecosystem.config.js` (`crypto` / `metals` / `xau`;
  `feed-server` untouched).
- Verified: precedence, role-prefix-wins, role→global fallback, shell>file, type
  coercion, comment stripping. Against the real `.env`, only the 8 cTrader cred keys are
  visible → every getter returns its default.

### Phase 2 — groups B / C / D / G ✅
Converted to `config.get_*` with today's values as defaults:
- **B — `core/guards.py`**: 11 anti-breakout thresholds (RSI-continuation, fade-impulse,
  no-re-arm, vol-spike).
- **C — `core/strategy.py`**: TP1-tighten + 8 ATR stop/target constants.
- **D — `scanner.py`**: dominance basket/thresholds, BTC vol circuit-breaker (6), regime
  hard-filter, and the **regime confidence matrix as a per-cell override layer**
  (`CRYPTO_BTC_D_RISING_BULLISH_BUY=…`). `REGIME_BLOCKS` left as code (structural policy).
- **G — `xau-scanner.py`**: SL/TP pips + all momentum indicator periods (AO / Bears /
  MACD / CCI / RSI) + signal confidence + lookback.

Verified: guards / regime / strategy / indicator harnesses all pass; feed identical except
the (separately added) `timestamp_local` field; overrides proven live end-to-end.

### Phase 3 — group F: timeframe shape knobs ✅
Added a `.env` override layer at the end of `get_timeframe_params`: after the base per-TF
matrix resolves, `LOOKBACK / BANDWIDTH / MULTIPLIER / RSI_PERIOD / MA_PERIOD /
CONFIRMATION_TIMEFRAME / STOP_DISTANCE / TARGET_1/2/3_PCT` are overridable per-scanner for
the active timeframe (no 120-key matrix dump). `max_positions` / `risk_per_trade` excluded
(bot-level → Phase 5).

Verified: strategy harness passes across all 10 timeframes; overrides apply; role isolation
confirmed (a `CRYPTO_*` key does not affect the metals process).

---

### Phase 4 — group E: signal weights + `weight %` ✅
The core of the tuning request. `detect_signals` had **42 inline** `confidence += / -=`
deltas across the filters (volume, MA trend, HTF confirmation, RSI divergence, price
velocity, HTF overrule, squeeze, SMRE, market structure, order block, FVG). Each is now
wrapped in a `_w(raw, W_<FILTER>_PCT)` helper exposing a **per-filter weight %** plus a
**global `SIGNAL_WEIGHT_PCT`** (all default 100):

```
effective_delta = raw × (W_<FILTER>_PCT / 100) × (SIGNAL_WEIGHT_PCT / 100)
```

The 11 filter weights: `W_VOLUME_PCT`, `W_MA_PCT`, `W_HTF_PCT`, `W_DIVERGENCE_PCT`,
`W_VELOCITY_PCT`, `W_HTF_OVERRULE_PCT`, `W_SQUEEZE_PCT`, `W_SMRE_PCT`, `W_STRUCTURE_PCT`,
`W_OB_PCT`, `W_FVG_PCT`. At 100/100 nothing changes; `CRYPTO_W_STRUCTURE_PCT=150` makes SMC
structure matter 50% more, for crypto only. FILTER 0 (anti-breakout guards) is excluded —
already tunable via the group-B guard constants, and it's veto logic, not additive weight.

> **Design note:** raw magnitudes stay inline in the `_w()` calls (e.g. `_w(25, W_VOLUME_PCT)`)
> rather than becoming ~26 extra named constants — 12 weight keys instead of ~38, a cleaner
> `scanner.config`, same "per-filter weights + global scale" behaviour.

Verified: no bare digit deltas remain; **structural diff vs git** shows only the `_w()`
wrapper was added; byte-identical at default weights (detect_signals + regime harnesses);
overrides confirmed to shift confidence.

### Phase 5 — group A: bot/execution settings ✅
`--account-size` → `ACCOUNT_SIZE`, `--risk` → `RISK`, `--max-positions` → `MAX_POSITIONS`,
`-tf` → `TIMEFRAME`, `--loop` → `LOOP` — argparse defaults now sourced from `config`, in all
three scanners (xau has only TIMEFRAME/LOOP). Precedence **CLI > `scanner.config` > default**
verified: an explicit flag (incl. pm2's `-tf 1h --loop 15`) still wins.

### Phase 6 — `scanner.config` + docs + full verification ✅
`scanner.config` (repo root, tracked, fully commented) lists all **74 keys** grouped A–G
with defaults and the per-scanner prefix convention. Loader repointed from `.env` to
`scanner.config` (with `SCANNER_CONFIG` override for tests). Final run: all harnesses pass
at defaults; overrides via `scanner.config` (global + role) confirmed; `.env` no longer read
for settings.

---

## Caveat: bare-key collisions across roles

A few key names exist in more than one scanner (e.g. `RSI_PERIOD` is xau's momentum RSI
*and* the crypto/metals timeframe RSI period). A **bare** `RSI_PERIOD` would affect both;
use the role prefix (`XAU_RSI_PERIOD` vs `CRYPTO_RSI_PERIOD`) to tune them independently.
`scanner.config` calls these out (also `LOOKBACK`, `TIMEFRAME`, `LOOP`, `ACCOUNT_SIZE`,
`RISK`, `MAX_POSITIONS`).

## How to tune

1. Open `scanner.config`, uncomment the key(s) you want to change (prefix with
   `CRYPTO_` / `METALS_` / `XAU_` to target one scanner).
2. `pm2 restart signal-scanner metals-scanner xau-scanner` (the `--loop` holds code in
   memory, so edits apply on restart).
3. Let the feed accumulate, then measure with `backtest.py` and iterate.
