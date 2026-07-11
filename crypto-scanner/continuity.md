# continuity.md — how this project is developed

A rebuild document. If you're a fresh Claude instance picking this project up on another
machine with no memory of prior sessions, read this first — it's not a feature list (that's
`README.md`), it's the *method* we use to build here, plus the working conventions the user
expects. Read `README.md` for what exists; read this for how new things get added.

---

## 1. What this is

A multi-asset **signal generator** (crypto via Binance, gold/silver/NASDAQ-100 via cTrader).
Each scanner runs resident under pm2, loops on a timer, and writes signals to the shared
`data/alerts.json` feed. An external repo, **doochybot**, polls that feed and executes orders —
this repo never places a trade. The two sides are fully decoupled; the feed schema
(`docs/FEED_CONTRACT.md`) is the only contract between them.

The user (owner of both repos) treats this as a real trading system, not a toy — money is on
the line via a prop account. That shapes everything below: nothing ships on vibes.

---

## 2. The core method: backtest first, ship only what earns it

This is the most important thing to internalize. Every scanner in this repo — gold, silver,
the 15m gold companion, US100 — was built the same way, and the next one should be too:

1. **Get the real data first.** Pull history from the actual source (`ctrader_feed.py` for
   metals/index, Binance for crypto) before writing any strategy code. Check how much history
   is actually available — it varies a lot by timeframe (cTrader keeps ~7 months at ≤15m,
   ~2.2 years at 1h; 4h/1d error out on large `count` requests).
2. **Build a basket of candidate strategies**, not one. Momentum/breakout, pullback,
   mean-reversion/fade, session-structure (opening range, VWAP) — whichever are plausible for
   the instrument. Write them as vectorised backtest functions in the scratchpad (never
   committed), sharing one walk-forward evaluator.
3. **Walk-forward, cost-adjusted, SL-first-on-same-bar.** If a signal bar's stop and target are
   both touched by the same later bar, assume the stop filled first (conservative — you can't
   see intrabar order). Convert a fixed $/point cost into R so expectancy is comparable across
   instruments.
4. **Only keep what's robust, not just positive.** A single positive avgR number is not enough.
   Check, every time:
   - **BUY vs SELL split.** A strategy whose edge is 100% one-sided is usually riding the
     sample's directional bias (a bull market), not exploiting a real structural edge. This
     has killed candidates twice (US100 15m momentum backtested "positive" but was long-only
     bull-beta with a deeply negative short side — rejected outright).
   - **Regime-thirds / sample-half split.** Cut the backtest window into thirds (or halves) and
     check the edge holds in each. An edge that only lived in one third is fragile.
   - **Parameter plateau, not a fitted point.** Sweep the key parameter (donchian lookback,
     stop/TP multiple) and confirm a *range* works, not one lucky value.
   - **Win% vs breakeven win%.** A low win rate is not automatically bad — compare it against
     `1/(1+reward:risk)`. A 2:1 target only needs 33% wins to break even; tightening the target
     to raise win% usually *reduces* expectancy (proven repeatedly: gold S3's old 0.5 R:R
     geometry was the single worst config tested).
   - **Sample-bias caveat, stated out loud.** If the whole backtest window trended one way
     (e.g., gold +33% over the sample, US100 all-bull on the 15m data), say so explicitly, even
     for a strategy that passed the above checks — future regime shifts are the real risk.
5. **Document the rejects, not just the winner.** Failed candidates go in the shipped file's
   module docstring ("REJECTED — don't re-add without new evidence") and in project memory.
   Don't let a future session re-discover that RSI(2) has no edge on 15m gold, or that VWAP-fade
   is fragile on gold, or that wick-rejection has no edge on gold at all (it works on silver —
   strategies do **not** automatically transfer between instruments, even ones that look similar).
6. **Build the scanner only after the data has picked the strategy.** Reuse `core/trend.py`
   (indicators + strategies + confluence), `core/guards.py` (whipsaw, no-re-arm, vol-spike),
   `core/feed.py` (the one write path + dedupe), `core/health.py` (watchdog). Don't duplicate
   logic per scanner — that duplication is exactly what caused past drift (the retired
   metals-scanner/xag-scanner/xau-scanner era had `detect_signals` copy-pasted across files).
7. **Replay-parity check before calling it done.** Write a scratchpad script that calls the
   *live* scanner functions on the same historical bars the backtest used, and assert the
   live-emitted direction matches the backtest trigger on every single bar, with zero
   false-positives on a sample of non-trigger bars. This is non-negotiable — "the backtest
   said X" and "the live code actually does X" are different claims, and only this check
   proves the second one.
8. **Compile, then one live single-scan smoke test.** `python3 -m py_compile`, then a real
   `python3 <scanner>.py -v` against the live feed, checked by eye.
9. **Ship to `ecosystem.config.js` COMMENTED OUT.** New scanners never auto-start. The user
   decides go-live after watching it run standalone for a bit. Don't uncomment it yourself.
10. **New instrument/strategy = its own `signal_source`, independent feed stream.** Don't wire
    cross-scanner dedupe or exposure-netting logic into the scanner — that's explicitly
    doochybot's job. The feed's dedupe (`src_bar`-keyed, see `core/feed.py`) only applies
    *within* one `signal_source`.
11. **Save the outcome to memory — winners and rejects both** — before ending the session. See
    §5.

If a step in this list gets skipped (especially #4's robustness checks or #7's parity check),
say so explicitly rather than silently shipping something less validated than it looks.

---

## 3. Architecture at a glance

```
scanner.py, gold-scanner.py, gold-15m-scanner.py,   # one process per instrument/strategy-family
silver-scanner.py, us100-scanner.py                 # each --loop's on its own timer, writes the feed
ctrader_feed.py                                      # shared cTrader Open API client (gold/silver/US100)
core/
  trend.py       # pure indicator + strategy functions (ema/atr/rsi, cloud_pullback, rsi2_pullback, combine)
  guards.py       # whipsaw/session-open guard, no-re-arm, volatility-spike penalty
  feed.py         # THE ONE write path to data/alerts.json — normalisation, dedupe, atomic write
  health.py       # per-scanner ok/error heartbeat -> data/scanner_health.json, alarms after 3 failures
  config.py       # env/scanner.config/code-default resolution, per-scanner ROLE-prefixed overrides
  strategy.py, indicators.py   # scanner.py's (crypto) own detector + position sizing
backtest.py        # replays data/alerts.json against Binance history (crypto/scanner.py side only)
ecosystem.config.js # pm2 process defs — source of truth for what's live vs commented-out-pending
old/               # retirement bucket for BOTH code and docs — see §4
docs/              # design specs the LIVE code still references (hmm.md, FEED_CONTRACT.md, ...)
```

Config convention: every scanner-tunable constant reads through `core/config.py` as
`config.get_*("<PREFIX>_KEY", <code-default>)`. Each scanner has its own prefix
(`GOLD_*`, `X15_*`, `SILVER_*`, `U100_*`, `CRYPTO_*`) selected by `SCANNER_ROLE` in its pm2 env
block. `scanner.config` holds only the overrides someone actually set; an absent file means
every scanner runs on its baked-in code defaults. No secrets there — `.env` alone holds cTrader
credentials, and is gitignored.

---

## 4. Repo hygiene pattern

- **`old/`** is where retired code AND its docs go together — not just code. When a scanner is
  retired, move its script *and* its dedicated README/doc into `old/` (or `old/docs/`) in the
  same pass, and scrub `README.md`'s tree/tables so they don't keep describing something that
  no longer exists. This drifted once (README described `metals-scanner.py`/`xau-scanner.py`/
  `btc-scanner.py` as live stack members for over a week after they were deleted) — don't let
  it happen again.
- **`docs/`** is for design specs the *live* code still cites (e.g. `gold-scanner.py`'s
  docstring points at `docs/hmm.md` for the S1 spec). If a doc stops being referenced by
  anything live, it belongs in `old/docs/`, not `docs/`.
- Scratchpad backtest scripts (the Phase-1 basket tests, robustness sweeps, parity checks) are
  **never committed** — they live in the session scratchpad only. The *findings* get written
  into the shipped file's docstring and into memory; the scripts themselves are disposable.
- Dead logs/`.pyc` files for scanners that no longer run pile up in `logs/`/`__pycache__/` —
  gitignored, so it's pure disk hygiene, safe to delete without asking twice once confirmed.

---

## 5. Memory system

There's a persistent auto-memory at
`/home/algo/.claude/projects/-home-algo-crypto-scanner/memory/` (indexed by `MEMORY.md`),
separate from this file. It holds point-in-time project facts, feedback, and references —
**read it at the start of a session** if picking up prior work, but verify anything it claims
about current code/file state before asserting it as fact (memories say when they were written;
they're snapshots, not live state). This `continuity.md` is the distilled, durable *method*;
the memory files are the dated, decaying *history* of what was actually done and found. Keep
writing to both: memory after each scanner/feature ships (what was found, what was rejected,
why), this file only when the *method itself* changes.

---

## 6. Working conventions (how the user likes to collaborate)

- **Ask, don't guess, on genuine judgment calls** — strategy-family choice, scope (which
  instruments, ship vs shelve), what to do with an ambiguous edge (e.g. "the SELL side is flat,
  emit it anyway or cut it?"), destructive/bulk file operations. Use structured
  multiple-choice questions with a recommended option marked, not open-ended asks. Don't ask
  about things derivable from the code or from re-running a command yourself.
- **Report negative results as plainly as positive ones.** "This basket failed, here's why, here's
  what I'd try instead" is a normal, expected outcome — not a problem to hide or hedge around. The
  user explicitly values the rejected-candidate list as much as the shipped one.
- **Explain surprising numbers, don't just report them.** When win% looked alarmingly low, the
  right response was to derive the breakeven win rate and explain why a low number is
  *expected* for a positive-R:R momentum system — not to just restate the number.
  Same instinct applies to anything else that looks off at a glance: numbers, config values,
  behavior — check whether it's actually a mismatch before treating it as one.
- **Git**: never commit unless explicitly asked. Uncommitted work sitting in the tree between
  sessions is the normal flow here, not an oversight to fix. When asked for a commit message
  "no technical details," write it as plain narrative (what changed and why it matters,
  no file names/jargon) rather than a technical changelog line.
- **pm2 / live state**: new scanners ship commented-out; the user uncomments and starts them
  when ready. After confirming a scanner is running, check `pm2 jlist` (status/restart count/
  uptime) and the health-watchdog JSON, not just the latest log lines — a single old traceback
  in a log doesn't mean the process is unhealthy now.
- **Be concise.** Direct answers to direct questions; save the long-form write-ups for backtest
  result reporting, where the detail (n, win%, avgR, splits) is the actual deliverable.

---

## 7. If you're rebuilding from scratch

Read, in order: this file → `README.md` (current stack) → `docs/FEED_CONTRACT.md` (the feed
schema/execution model) → the memory index (`MEMORY.md`) for recent project history → the
module docstring of whichever scanner you're about to touch (each one documents its own
backtest citations and rejected alternatives inline). Then apply §2 to whatever comes next.
