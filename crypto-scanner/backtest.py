#!/usr/bin/env python3
"""
Backtest the trading signals published to data/alerts.json.

Each alert carries a direction (buy/sell), an entry target (`price`) and absolute
SL / TP levels. This script replays every alert against historical OHLCV pulled
from Binance (same source the scanner uses) and reports how many hit TP vs SL,
the R-multiple distribution, and win rate — broken down by symbol and direction.

Entry model (mirrors the feed→execution contract, see docs/FEED_CONTRACT.md):
  `price` is a TARGET level, not a market fill. By default we only take a trade
  if price trades through the target within --entry-window bars (a resting
  limit/stop fill); unfilled orders are dropped, matching doochybot's stale-order
  expiry. Use --entry-mode market to instead fill at the next candle open.

Resolution: after entry we walk candles forward until TP or SL is touched, or
--max-bars elapses (trade left open). If a single candle spans both SL and TP we
assume SL filled first (conservative, since we can't see intrabar order).

Usage:
  python3 backtest_alerts.py
  python3 backtest_alerts.py --entry-mode market --max-bars 96
  python3 backtest_alerts.py --source signal_scanner --min-conf 60
"""

import argparse
import json
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

import ccxt


def load_alerts(source):
    """Load the alerts feed from a local path or an http(s) URL.

    Returns [] (with a warning) when the feed is empty or not valid JSON — e.g. the live
    feed currently holds no alerts, or the server returned an empty 200 — so the backtest
    reports 'nothing to do' instead of crashing with a JSONDecodeError."""
    if source.startswith(('http://', 'https://')):
        # Send a normal UA — some servers 403 the default urllib agent.
        req = urllib.request.Request(source, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode('utf-8')
    else:
        with open(source) as f:
            raw = f.read()

    if not raw.strip():
        print(f'⚠️ alerts feed is empty: {source}', file=sys.stderr)
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f'⚠️ alerts feed is not valid JSON ({source}): {e}', file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Config / helpers
# ---------------------------------------------------------------------------

# Milliseconds per candle for the timeframes the scanner emits.
TF_MS = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
    '1d': 86_400_000,
}

# Alert symbols are cTrader-style "<BASE>USD" (e.g. BCHUSD). Map back to the ccxt symbol.
# Crypto maps to the Binance SPOT pair the scanner fetches. Metals (XAU/XAG) aren't on
# Binance spot — they trade as USDⓈ-M FUTURES ("<BASE>/USDT:USDT"), so they map to that and
# are fetched from the futures exchange (see fetch_ohlcv). NOTE: live metals alerts are
# cTrader-priced; Binance-futures gold/silver track closely (~spot) but aren't the same
# feed, so a metals backtest is an approximation, not an exact replay.
METALS_CCXT = {'XAUUSD': 'XAU/USDT:USDT', 'XAGUSD': 'XAG/USDT:USDT'}

def alert_symbol_to_ccxt(sym):
    if sym in METALS_CCXT:
        return METALS_CCXT[sym]
    if sym.endswith('USD') and not sym.endswith('USDT'):
        return sym[:-3] + '/USDT'
    if sym.endswith('USDT'):
        return sym[:-4] + '/USDT'
    return sym


def parse_ts(s):
    """Alert timestamps are 'YYYY-MM-DD HH:MM:SS', treated as UTC → epoch ms."""
    dt = datetime.strptime(s, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


_exchanges = {}
def get_exchange(futures=False):
    """Spot Binance for crypto; USDⓈ-M futures (binanceusdm) for metals perps."""
    key = 'futures' if futures else 'spot'
    if key not in _exchanges:
        if futures:
            _exchanges[key] = ccxt.binanceusdm({'enableRateLimit': True})
        else:
            _exchanges[key] = ccxt.binance({'enableRateLimit': True,
                                            'options': {'defaultType': 'spot'}})
    return _exchanges[key]


def fetch_ohlcv(symbol, timeframe, since_ms, need):
    """Fetch `need` candles starting at since_ms, with retry/paging."""
    # ccxt futures symbols carry a settlement suffix (e.g. XAU/USDT:USDT) → futures exchange.
    ex = get_exchange(futures=':' in symbol)
    step = TF_MS[timeframe]
    out = []
    since = since_ms
    while len(out) < need:
        for attempt in range(3):
            try:
                batch = ex.fetch_ohlcv(symbol, timeframe, since=since,
                                       limit=min(1000, need - len(out) + 5))
                break
            except Exception as e:
                if attempt == 2:
                    raise
                time.sleep(0.5 * (2 ** attempt))
        if not batch:
            break
        out.extend(batch)
        since = batch[-1][0] + step
        if len(batch) < 2:
            break
    return out


def fetch_ctrader(alert_sym, timeframe, since_ms, need):
    """OHLCV for a metals alert from cTrader — the exact venue metals signals are
    generated (and traded) on, so more accurate than Binance's gold/silver perps.

    Metals are a sessioned market (closed weekends + the daily 21-22 UTC settle), so a
    window of exactly `need` bars starves whenever a closure falls inside it — e.g. a
    Friday-evening alert returned 0 bars and the trade was silently skipped instead of
    resolving after the weekend. Request a generously wider window (closures contain no
    bars, so this costs nothing) and cap the result at `need` bars."""
    import ctrader_feed
    to_ms = since_ms + (need + 2) * TF_MS[timeframe] + 3 * 86_400_000  # +3 days for closures
    df = ctrader_feed.get_trendbars_range(alert_sym, timeframe, since_ms, to_ms)
    if df is None or len(df) == 0:
        return []
    return df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].head(need + 2).values.tolist()


def fetch_candles(alert_sym, timeframe, since_ms, need):
    """Route each alert to the venue it was generated on: metals → cTrader (exact
    source), crypto → Binance spot. Metals fall back to Binance USDⓈ-M futures if
    cTrader is unavailable (no creds / connection), with a warning."""
    if alert_sym in METALS_CCXT:
        try:
            return fetch_ctrader(alert_sym, timeframe, since_ms, need)
        except Exception as e:
            print(f'⚠️ {alert_sym}: cTrader fetch failed ({str(e)[:50]}) — '
                  f'falling back to Binance futures', file=sys.stderr)
            return fetch_ohlcv(METALS_CCXT[alert_sym], timeframe, since_ms, need)
    return fetch_ohlcv(alert_symbol_to_ccxt(alert_sym), timeframe, since_ms, need)


# ---------------------------------------------------------------------------
# Single-trade simulation
# ---------------------------------------------------------------------------

def simulate(alert, candles, entry_mode, entry_window, max_bars, tp_scale=1.0):
    """Return a dict describing the trade outcome, or None if we can't evaluate.

    tp_scale pulls the take-profit toward the entry anchor without touching the
    stop: tp_scale=1.0 is the alert's original TP, 0.5 is halfway between `price`
    and TP, etc. Lets us test a tighter / more-probable TP while SL stays put.
    """
    direction = alert['direction'].lower()   # 'buy' / 'sell'
    target = float(alert['price'])
    sl = float(alert['sl'])
    tp = target + tp_scale * (float(alert['tp']) - target)
    is_buy = direction == 'buy'

    # candles: [ts, o, h, l, c, v], strictly after signal time already sliced.
    if not candles:
        return None

    # --- entry ---
    if entry_mode == 'market':
        entry_price = candles[0][1]          # next candle open
        start_idx = 0
    else:  # 'target' — wait for price to trade through the level
        entry_price = None
        start_idx = None
        for i, c in enumerate(candles[:entry_window]):
            _, o, h, l, cl, _ = c
            if l <= target <= h:             # candle range straddles target
                entry_price = target
                start_idx = i
                break
        if entry_price is None:
            return {'status': 'no_fill', 'direction': direction,
                    'symbol': alert['symbol']}

    risk = abs(entry_price - sl)
    if risk == 0:
        return None

    # --- resolution: walk forward from the entry candle ---
    walk = candles[start_idx: start_idx + max_bars]
    for c in walk:
        _, o, h, l, cl, _ = c
        hit_sl = (l <= sl) if is_buy else (h >= sl)
        hit_tp = (h >= tp) if is_buy else (l <= tp)
        if hit_sl and hit_tp:
            outcome, exit_price = 'sl', sl     # conservative: SL first
        elif hit_tp:
            outcome, exit_price = 'tp', tp
        elif hit_sl:
            outcome, exit_price = 'sl', sl
        else:
            continue

        pnl = (exit_price - entry_price) if is_buy else (entry_price - exit_price)
        return {
            'status': 'win' if outcome == 'tp' else 'loss',
            'outcome': outcome,
            'direction': direction,
            'symbol': alert['symbol'],
            'entry': entry_price,
            'exit': exit_price,
            'r': pnl / risk,
            'pct': pnl / entry_price * 100,
        }

    # never resolved. Distinguish "held to max_bars without hitting TP/SL" (open)
    # from "ran out of history before max_bars elapsed" (pending — too recent).
    last_close = walk[-1][4]
    pnl = (last_close - entry_price) if is_buy else (entry_price - last_close)
    status = 'open' if len(walk) >= max_bars else 'pending'
    return {
        'status': status,
        'direction': direction,
        'symbol': alert['symbol'],
        'entry': entry_price,
        'exit': last_close,
        'bars_available': len(walk),
        'r': pnl / risk,
        'pct': pnl / entry_price * 100,
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def pct(n, d):
    return f'{(100 * n / d):.1f}%' if d else 'n/a'


def print_report(results, args):
    resolved = [r for r in results if r['status'] in ('win', 'loss')]
    wins = [r for r in resolved if r['status'] == 'win']
    losses = [r for r in resolved if r['status'] == 'loss']
    opens = [r for r in results if r['status'] == 'open']
    pending = [r for r in results if r['status'] == 'pending']
    no_fill = [r for r in results if r['status'] == 'no_fill']

    print('=' * 60)
    print('  BACKTEST RESULTS')
    print('=' * 60)
    print(f'Alerts evaluated : {len(results)}')
    if no_fill:
        print(f'  no fill        : {len(no_fill)} (target not reached in '
              f'{args.entry_window} bars)')
    print(f'  resolved       : {len(resolved)}  (win {len(wins)} / loss {len(losses)})')
    print(f'  still open      : {len(opens)} (held full {args.max_bars} bars, no TP/SL)')
    if pending:
        print(f'  pending         : {len(pending)} (too recent — <{args.max_bars} bars '
              f'of history exist yet)')
    print()

    if resolved:
        total_r = sum(r['r'] for r in resolved)
        avg_r = total_r / len(resolved)
        print(f'Win rate        : {pct(len(wins), len(resolved))}')
        print(f'Total R         : {total_r:+.2f}')
        print(f'Avg R / trade   : {avg_r:+.3f}')
        print(f'Expectancy (%)  : {sum(r["pct"] for r in resolved)/len(resolved):+.3f}% per trade')
        gross_win = sum(r['r'] for r in wins)
        gross_loss = -sum(r['r'] for r in losses)
        pf = gross_win / gross_loss if gross_loss else float('inf')
        print(f'Profit factor   : {pf:.2f}')
    print()

    # by direction
    print('By direction:')
    for d in ('buy', 'sell'):
        sub = [r for r in resolved if r['direction'] == d]
        w = sum(1 for r in sub if r['status'] == 'win')
        r_sum = sum(r['r'] for r in sub)
        print(f'  {d:<4}  n={len(sub):<3}  win={pct(w, len(sub)):<7}  R={r_sum:+.2f}')
    print()

    # by symbol
    print('By symbol:')
    by_sym = defaultdict(list)
    for r in resolved:
        by_sym[r['symbol']].append(r)
    for sym in sorted(by_sym):
        sub = by_sym[sym]
        w = sum(1 for r in sub if r['status'] == 'win')
        r_sum = sum(r['r'] for r in sub)
        print(f'  {sym:<9} n={len(sub):<3}  win={pct(w, len(sub)):<7}  R={r_sum:+.2f}')
    print('=' * 60)


# ---------------------------------------------------------------------------
# De-duplication
# ---------------------------------------------------------------------------

def dedup_alerts(alerts, window_bars, verbose=False):
    """Collapse repeated signals of the same setup so one trade isn't counted
    multiple times. doochybot rejects these duplicates live, so counting each
    one here would inflate the backtest.

    A cluster = same (symbol, direction, timeframe) whose timestamps fall within
    `window_bars` of the cluster's first signal. Within a cluster we keep the
    single highest-confidence alert (ties → earliest) and drop the rest.

    Expects `alerts` sorted oldest-first. Returns (kept_alerts, n_dropped).
    """
    if window_bars <= 0:
        return alerts, 0

    clusters = {}           # key -> {'anchor_ms', 'best', 'members'}
    order = []              # preserve first-seen order of cluster ids
    dropped = 0

    def key_of(a):
        return (a['symbol'], a['direction'], a['timeframe'])

    kept = {}              # cluster id -> chosen alert
    for a in alerts:
        tf = a['timeframe']
        step = TF_MS.get(tf)
        if step is None:            # unknown TF: never merge, pass through
            cid = ('_raw', id(a))
            kept[cid] = a
            order.append(cid)
            continue
        k = key_of(a)
        ts = parse_ts(a['timestamp'])
        cur = clusters.get(k)
        if cur is not None and ts - cur['anchor_ms'] <= window_bars * step:
            # same setup, still inside the window → duplicate
            dropped += 1
            if a.get('confidence', 0) > cur['best'].get('confidence', 0):
                if verbose:
                    print(f'  dedup: {a["symbol"]} {a["direction"]} — '
                          f'{a["timestamp"]} conf {a.get("confidence")} replaces '
                          f'{cur["best"]["timestamp"]} conf '
                          f'{cur["best"].get("confidence")}', file=sys.stderr)
                kept.pop(cur['cid'], None)
                cid = ('c', k, ts)
                cur['best'] = a
                cur['cid'] = cid
                kept[cid] = a
                order.append(cid)
            elif verbose:
                print(f'  dedup: {a["symbol"]} {a["direction"]} — dropped '
                      f'{a["timestamp"]} conf {a.get("confidence")} '
                      f'(<= kept {cur["best"].get("confidence")})', file=sys.stderr)
        else:
            # new cluster (or window elapsed → re-arm)
            cid = ('c', k, ts)
            clusters[k] = {'anchor_ms': ts, 'best': a, 'cid': cid}
            kept[cid] = a
            order.append(cid)

    kept_alerts = [kept[cid] for cid in order if cid in kept]
    kept_alerts.sort(key=lambda a: a['timestamp'])
    return kept_alerts, dropped


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--alerts', default='https://signals.route07.com/alerts.json',
                    help='alerts feed: an http(s) URL or a local path '
                         '(default: the live route07 feed)')
    ap.add_argument('--entry-mode', choices=['target', 'market'], default='target',
                    help='target: fill only if price reaches `price` within '
                         '--entry-window bars (default). market: fill at next open.')
    ap.add_argument('--entry-window', type=int, default=3,
                    help='bars to wait for a target fill (default 3, matches '
                         'staleOrderBars)')
    ap.add_argument('--max-bars', type=int, default=192,
                    help='max bars to hold before marking a trade open '
                         '(default 192 = 48h on 15m)')
    ap.add_argument('--tp-scale', type=float, default=1.0,
                    help='pull TP toward entry, SL unchanged. 1.0=alert TP, '
                         '0.5=halfway, 0.25=quarter. Tests a tighter/more-probable '
                         'target (default 1.0)')
    ap.add_argument('--dedup-window', type=int, default=4,
                    help='collapse repeated same-symbol/direction/timeframe '
                         'signals within this many bars into one trade (keeps '
                         'the highest confidence). doochybot rejects these live, '
                         'so counting each inflates results. 0 disables '
                         '(default 4 = 1h on 15m)')
    ap.add_argument('--source', help='only backtest alerts from this signal_source')
    ap.add_argument('--symbol', help='only this alert symbol (e.g. BTCUSD)')
    ap.add_argument('--min-conf', type=float, help='minimum confidence filter')
    ap.add_argument('--json-out', help='write per-trade results to this JSON file')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='print each de-duplicated signal')
    args = ap.parse_args()

    alerts = load_alerts(args.alerts)

    # filters
    if args.source:
        alerts = [a for a in alerts if a.get('signal_source') == args.source]
    if args.symbol:
        alerts = [a for a in alerts if a['symbol'] == args.symbol]
    if args.min_conf is not None:
        alerts = [a for a in alerts if a.get('confidence', 0) >= args.min_conf]

    if not alerts:
        print('No alerts match filters.')
        return

    # oldest first, so a trade's resolution window can extend toward "now"
    alerts.sort(key=lambda a: a['timestamp'])

    # collapse duplicate re-fires of the same setup (doochybot rejects these live)
    n_raw = len(alerts)
    alerts, n_dropped = dedup_alerts(alerts, args.dedup_window, args.verbose)
    if n_dropped:
        print(f'De-dup: {n_raw} alerts → {len(alerts)} unique setups '
              f'({n_dropped} duplicates collapsed, '
              f'{args.dedup_window}-bar window)\n')

    results = []
    for a in alerts:
        tf = a['timeframe']
        if tf not in TF_MS:
            print(f'skip {a["symbol"]} — unsupported timeframe {tf}', file=sys.stderr)
            continue
        sig_ms = parse_ts(a['timestamp'])
        need = args.entry_window + args.max_bars + 2

        # fetch candles strictly after the signal, from the venue the signal came from
        try:
            candles = fetch_candles(a['symbol'], tf, sig_ms + TF_MS[tf], need)
        except Exception as e:
            print(f'⚠️ {a["symbol"]} @ {a["timestamp"]}: fetch failed - '
                  f'{str(e)[:60]}', file=sys.stderr)
            continue

        if not candles:
            continue

        res = simulate(a, candles, args.entry_mode, args.entry_window,
                       args.max_bars, args.tp_scale)
        if res is None:
            continue
        res['timestamp'] = a['timestamp']
        res['confidence'] = a.get('confidence')
        results.append(res)

    if not results:
        print('No evaluable trades (data may be too recent).')
        return

    print_report(results, args)

    if args.json_out:
        with open(args.json_out, 'w') as f:
            json.dump(results, f, indent=2)
        print(f'\nPer-trade results → {args.json_out}')


if __name__ == '__main__':
    main()
