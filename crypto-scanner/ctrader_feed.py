#!/usr/bin/env python3
"""
ctrader_feed.py — synchronous cTrader Open API client for OHLC (trendbar) data.

Speaks the cTrader Open API JSON protocol over TLS (port 5036). The crypto
scanners source forex / indices / metals candles from cTrader (more accurate
than Binance perps, since we trade on cTrader), while crypto stays on Binance.

Public API:
    get_trendbars(symbol, timeframe, count=200) -> pandas.DataFrame | None
        columns ['timestamp','open','high','low','close','volume'], oldest first,
        matching the shape scanner.fetch_data() already returns.
    list_symbols(query=None) -> list[str]

Design notes:
  * One self-contained module, no Twisted / protobuf codegen / separate service.
  * Credentials live in crypto-scanner/.env. Access tokens last ~30 days; on an
    expired-token error the client refreshes via the refresh token and persists
    the rotated pair back to .env (refresh is single-use, so persistence matters).
  * One TLS connection + auth is reused for all cTrader symbols in a single
    process run (module-level singleton).

Standalone check:
    python3 ctrader_feed.py --probe        # auth, list symbols, fetch XAUUSD H1
    python3 ctrader_feed.py --symbols gold  # search the broker's symbol names
"""

import os
import ssl
import json
import time
import uuid
import codecs
import socket
import threading

import pandas as pd

# ============================================================
# CONFIG / CREDENTIALS
# ============================================================

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH = os.path.join(_HERE, ".env")


def _load_env(path=_ENV_PATH):
    env = {}
    if not os.path.exists(path):
        return env
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def _persist_tokens(access_token, refresh_token, path=_ENV_PATH):
    """Rewrite ACCESS_TOKEN / REFRESH_TOKEN in .env, preserving everything else.
    Written atomically so a crash can't truncate the credentials file."""
    lines = []
    seen = {"ACCESS_TOKEN": False, "REFRESH_TOKEN": False}
    for line in open(path):
        stripped = line.strip()
        if stripped.startswith("ACCESS_TOKEN=") and not seen["ACCESS_TOKEN"]:
            lines.append(f"ACCESS_TOKEN={access_token}\n")
            seen["ACCESS_TOKEN"] = True
        elif stripped.startswith("REFRESH_TOKEN=") and not seen["REFRESH_TOKEN"]:
            lines.append(f"REFRESH_TOKEN={refresh_token}\n")
            seen["REFRESH_TOKEN"] = True
        else:
            lines.append(line if line.endswith("\n") else line + "\n")
    if not seen["ACCESS_TOKEN"]:
        lines.append(f"ACCESS_TOKEN={access_token}\n")
    if not seen["REFRESH_TOKEN"]:
        lines.append(f"REFRESH_TOKEN={refresh_token}\n")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(lines)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# ProtoPayloadType (common) + ProtoOAPayloadType (open API) message IDs.
PT = {
    "HEARTBEAT_EVENT": 51,
    "ERROR_RES": 50,
    "APP_AUTH_REQ": 2100,
    "APP_AUTH_RES": 2101,
    "ACCOUNT_AUTH_REQ": 2102,
    "ACCOUNT_AUTH_RES": 2103,
    "SYMBOLS_LIST_REQ": 2114,
    "SYMBOLS_LIST_RES": 2115,
    "GET_TRENDBARS_REQ": 2137,
    "GET_TRENDBARS_RES": 2138,
    "OA_ERROR_RES": 2142,
    "REFRESH_TOKEN_REQ": 2173,
    "REFRESH_TOKEN_RES": 2174,
}

# scanner timeframe string -> (ProtoOATrendbarPeriod enum, bar length in minutes)
TIMEFRAMES = {
    "1m": (1, 1),
    "5m": (5, 5),
    "15m": (7, 15),
    "30m": (8, 30),
    "1h": (9, 60),
    "4h": (10, 240),
    "12h": (11, 720),
    "1d": (12, 1440),
}

# Timeframes cTrader has no native trendbar period for: fetched from a base
# period and resampled. (base timeframe, multiple)
DERIVED_TIMEFRAMES = {
    "2h": ("1h", 2),
    "6h": ("1h", 6),
}

PRICE_SCALE = 100000.0
# Broker suffixes for indices/commodities (US30 -> US30.cash etc.)
SYMBOL_SUFFIXES = ["", ".cash", ".spot", "."]
# cTrader throttles historical (trendbar) requests harder than the 50/s live
# limit; keep a minimum gap between them and retry on a rate-limit error.
MIN_TRENDBAR_INTERVAL = 0.6


class CTraderError(Exception):
    pass


# ============================================================
# SYNCHRONOUS JSON-OVER-TLS CLIENT
# ============================================================

class CTraderFeed:
    def __init__(self, env=None):
        self.env = env or _load_env()
        self.host = self.env.get("CTRADER_HOST", "live.ctraderapi.com")
        self.port = int(self.env.get("CTRADER_PORT", "5036"))
        self.client_id = self.env["CLIENT_ID"]
        self.client_secret = self.env["CLIENT_SECRET"]
        self.access_token = self.env["ACCESS_TOKEN"]
        self.refresh_token = self.env["REFRESH_TOKEN"]
        self.account_id = int(self.env["ACCOUNT_ID"])
        self.sock = None
        self.authed = False
        self.symbol_map = {}  # name -> symbolId
        self._lock = threading.Lock()
        self._buf = ""  # decoded inbound text awaiting a complete JSON object
        self._dec = codecs.getincrementaldecoder("utf-8")()
        self._json = json.JSONDecoder()
        self._last_trendbar = 0.0  # for historical-request self-pacing

    # ---- low-level framing -------------------------------------------------
    # The JSON protocol on :5036 is NOT length-prefixed (unlike protobuf on
    # :5035): each message is a raw JSON object on the TLS stream. We send the
    # bare JSON and parse the inbound stream one object at a time.
    def _open(self):
        ctx = ssl.create_default_context()
        raw = socket.create_connection((self.host, self.port), timeout=15)
        self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock.settimeout(15)
        self._buf = ""
        self._dec = codecs.getincrementaldecoder("utf-8")()

    def _send(self, payload_type, payload, msg_id=None):
        msg_id = msg_id or uuid.uuid4().hex
        body = json.dumps(
            {"clientMsgId": msg_id, "payloadType": payload_type, "payload": payload}
        )
        self.sock.sendall(body.encode("utf-8"))
        return msg_id

    def _recv_frame(self):
        while True:
            stripped = self._buf.lstrip()
            if stripped:
                try:
                    obj, end = self._json.raw_decode(stripped)
                    self._buf = stripped[end:]
                    return obj
                except json.JSONDecodeError:
                    pass  # incomplete object, read more
            chunk = self.sock.recv(4096)
            if not chunk:
                # OSError subclass so _with_reconnect treats it as a dropped socket
                raise ConnectionError("connection closed by server")
            self._buf += self._dec.decode(chunk)

    def _request(self, payload_type, payload, expect_type):
        """Send a request and return the payload of the matching response,
        skipping unsolicited heartbeats. Raises on error responses."""
        msg_id = self._send(payload_type, payload)
        deadline = time.time() + 20
        while time.time() < deadline:
            frame = self._recv_frame()
            ptype = frame.get("payloadType")
            if ptype == PT["HEARTBEAT_EVENT"]:
                continue
            if ptype in (PT["ERROR_RES"], PT["OA_ERROR_RES"]):
                pl = frame.get("payload", {})
                raise CTraderError(
                    f"{pl.get('errorCode', 'ERROR')}: {pl.get('description', '')}"
                )
            # Match by id when present; otherwise fall back to expected type.
            if frame.get("clientMsgId") == msg_id or ptype == expect_type:
                return frame.get("payload", {})
        raise CTraderError(f"timeout waiting for response type {expect_type}")

    # ---- auth --------------------------------------------------------------
    def _refresh_access_token(self):
        pl = self._request(
            PT["REFRESH_TOKEN_REQ"],
            {"refreshToken": self.refresh_token},
            PT["REFRESH_TOKEN_RES"],
        )
        self.access_token = pl["accessToken"]
        self.refresh_token = pl["refreshToken"]
        _persist_tokens(self.access_token, self.refresh_token)
        print("  🔑 cTrader access token refreshed and persisted")

    def connect(self):
        if self.authed:
            return
        self._open()
        self._request(
            PT["APP_AUTH_REQ"],
            {"clientId": self.client_id, "clientSecret": self.client_secret},
            PT["APP_AUTH_RES"],
        )
        try:
            self._account_auth()
        except CTraderError as e:
            # Token expired/invalid -> refresh once and retry account auth.
            if "TOKEN" in str(e).upper() or "EXPIRED" in str(e).upper():
                self._refresh_access_token()
                self._account_auth()
            else:
                raise
        self._load_symbols()
        self.authed = True

    def _reset(self):
        """Drop the current connection so the next call reconnects fresh."""
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        self.sock = None
        self.authed = False

    def _with_reconnect(self, fn):
        """Run fn(), reconnecting once on a socket failure. Long-running loops
        (e.g. xag-scanner --loop) reuse the connection across minutes, and
        cTrader drops idle sockets — so transparently re-establish and retry.
        Only OSError-family failures (incl. ssl.SSLError, ConnectionError)
        trigger a reconnect; logical CTraderErrors propagate as-is."""
        last = None
        for _ in range(2):
            try:
                self.connect()
                return fn()
            except OSError as e:
                last = e
                self._reset()
        raise CTraderError(f"cTrader connection failed: {last}")

    def _account_auth(self):
        self._request(
            PT["ACCOUNT_AUTH_REQ"],
            {"accessToken": self.access_token, "ctidTraderAccountId": self.account_id},
            PT["ACCOUNT_AUTH_RES"],
        )

    def _load_symbols(self):
        pl = self._request(
            PT["SYMBOLS_LIST_REQ"],
            {"ctidTraderAccountId": self.account_id, "includeArchivedSymbols": False},
            PT["SYMBOLS_LIST_RES"],
        )
        self.symbol_map = {}
        for s in pl.get("symbol", []):
            name = s.get("symbolName") or s.get("name")
            if name is not None and s.get("symbolId") is not None:
                self.symbol_map[str(name)] = int(s["symbolId"])

    # ---- public API --------------------------------------------------------
    def resolve_symbol(self, requested):
        for suf in SYMBOL_SUFFIXES:
            if requested + suf in self.symbol_map:
                return requested + suf
        low = requested.lower()
        for name in self.symbol_map:
            if name.lower() == low or name.lower().startswith(low + "."):
                return name
        return None

    def list_symbols(self, query=None):
        with self._lock:
            self._with_reconnect(lambda: None)
            names = sorted(self.symbol_map)
            if query:
                q = query.lower()
                names = [n for n in names if q in n.lower()]
            return names

    def _request_trendbars(self, symbol_id, period, from_ms, to_ms):
        """One historical request (self-paced + retried on rate limit)."""
        payload = {
            "ctidTraderAccountId": self.account_id,
            "symbolId": symbol_id,
            "period": period,
            "fromTimestamp": from_ms,
            "toTimestamp": to_ms,
        }
        pl = None
        for attempt in range(4):
            # self-pace historical requests to stay under cTrader's limit
            gap = MIN_TRENDBAR_INTERVAL - (time.time() - self._last_trendbar)
            if gap > 0:
                time.sleep(gap)
            self._last_trendbar = time.time()
            try:
                pl = self._request(
                    PT["GET_TRENDBARS_REQ"], payload, PT["GET_TRENDBARS_RES"]
                )
                break
            except CTraderError as e:
                msg = str(e).lower()
                if "rate" in msg or "blocked_payload" in msg:
                    time.sleep(1.0 * (attempt + 1))  # back off and retry
                    continue
                raise
        if pl is None:
            raise CTraderError("trendbar request rate-limited after retries")
        rows = []
        for b in pl.get("trendbar", []):
            low_raw = float(b.get("low", 0))
            low = low_raw / PRICE_SCALE
            high = (low_raw + float(b.get("deltaHigh", 0))) / PRICE_SCALE
            opn = (low_raw + float(b.get("deltaOpen", 0))) / PRICE_SCALE
            close = (low_raw + float(b.get("deltaClose", 0))) / PRICE_SCALE
            ts = int(b.get("utcTimestampInMinutes", 0)) * 60 * 1000
            rows.append([ts, opn, high, low, close, float(b.get("volume", 0))])
        if not rows:
            return None
        return pd.DataFrame(
            rows, columns=["timestamp", "open", "high", "low", "close", "volume"]
        )

    def _fetch_native(self, symbol_id, period, minutes, count):
        # Sessioned markets (metals/forex/indices) close on weekends/holidays, so
        # a fixed window can fall short of `count` bars — especially early in the
        # trading week. Widen the lookback window until we have enough, capped.
        now_ms = int(time.time() * 1000)
        span_ms = count * minutes * 60 * 1000
        window = int(span_ms * 1.6)
        ceiling = int(span_ms * 12) + 7 * 24 * 3600 * 1000
        df = None
        for _ in range(6):
            df = self._request_trendbars(symbol_id, period, now_ms - window, now_ms)
            if df is not None and len(df) >= count:
                break
            if window >= ceiling:
                break
            window = min(window * 2, ceiling)
        return df

    @staticmethod
    def _resample(df, minutes):
        s = df.copy()
        s.index = pd.to_datetime(s["timestamp"], unit="ms", utc=True)
        agg = (
            s.resample(f"{minutes}min", label="left", closed="left")
            .agg(
                {
                    "timestamp": "first",
                    "open": "first",
                    "high": "max",
                    "low": "min",
                    "close": "last",
                    "volume": "sum",
                }
            )
            .dropna()
        )
        return agg.reset_index(drop=True)

    def get_trendbars(self, symbol, timeframe, count=200):
        with self._lock:
            return self._with_reconnect(
                lambda: self._get_trendbars_inner(symbol, timeframe, count)
            )

    def _get_trendbars_inner(self, symbol, timeframe, count):
        resolved = self.resolve_symbol(symbol)
        if resolved is None:
            raise CTraderError(f"symbol not found on account: {symbol}")
        symbol_id = self.symbol_map[resolved]

        if timeframe in TIMEFRAMES:
            period, minutes = TIMEFRAMES[timeframe]
            df = self._fetch_native(symbol_id, period, minutes, count)
        elif timeframe in DERIVED_TIMEFRAMES:
            base_tf, ratio = DERIVED_TIMEFRAMES[timeframe]
            base_period, base_min = TIMEFRAMES[base_tf]
            raw = self._fetch_native(
                symbol_id, base_period, base_min, count * ratio + ratio * 2
            )
            df = None if raw is None else self._resample(raw, base_min * ratio)
        else:
            raise CTraderError(f"unsupported timeframe: {timeframe}")

        if df is None:
            return None
        return df.tail(count).reset_index(drop=True)

    def get_trendbars_range(self, symbol, timeframe, from_ms, to_ms):
        """Historical OHLCV for an explicit [from_ms, to_ms] window (epoch ms).

        Unlike get_trendbars (most-recent `count` bars), this fetches a specific past
        window — what a backtest needs to replay a signal from its timestamp forward.
        Single request per call (no paging), so very large windows may be capped by
        cTrader's per-request limit; fine for typical backtest windows (a few hundred bars).
        """
        with self._lock:
            return self._with_reconnect(
                lambda: self._get_trendbars_range_inner(symbol, timeframe, from_ms, to_ms)
            )

    def _get_trendbars_range_inner(self, symbol, timeframe, from_ms, to_ms):
        resolved = self.resolve_symbol(symbol)
        if resolved is None:
            raise CTraderError(f"symbol not found on account: {symbol}")
        symbol_id = self.symbol_map[resolved]

        if timeframe in TIMEFRAMES:
            period, minutes = TIMEFRAMES[timeframe]
            df = self._request_trendbars(symbol_id, period, from_ms, to_ms)
        elif timeframe in DERIVED_TIMEFRAMES:
            base_tf, ratio = DERIVED_TIMEFRAMES[timeframe]
            base_period, base_min = TIMEFRAMES[base_tf]
            raw = self._request_trendbars(symbol_id, base_period, from_ms, to_ms)
            df = None if raw is None else self._resample(raw, base_min * ratio)
        else:
            raise CTraderError(f"unsupported timeframe: {timeframe}")

        if df is None:
            return None
        return df.sort_values("timestamp").reset_index(drop=True)

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.sock = None
        self.authed = False


# ============================================================
# MODULE-LEVEL SINGLETON (one connection per process run)
# ============================================================

_FEED = None


def _feed():
    global _FEED
    if _FEED is None:
        _FEED = CTraderFeed()
    return _FEED


def get_trendbars(symbol, timeframe, count=200):
    return _feed().get_trendbars(symbol, timeframe, count)


def get_trendbars_range(symbol, timeframe, from_ms, to_ms):
    return _feed().get_trendbars_range(symbol, timeframe, from_ms, to_ms)


def list_symbols(query=None):
    return _feed().list_symbols(query)


# ============================================================
# STANDALONE PROBE
# ============================================================

if __name__ == "__main__":
    import sys

    args = sys.argv[1:]
    if args and args[0] == "--symbols":
        q = args[1] if len(args) > 1 else None
        names = list_symbols(q)
        print(f"{len(names)} symbol(s)" + (f" matching '{q}'" if q else ""))
        for n in names[:60]:
            print("  ", n)
        sys.exit(0)

    # default: --probe
    feed = _feed()
    print(f"Connecting to {feed.host}:{feed.port} (account {feed.account_id})...")
    feed.connect()
    print(f"✅ authed — {len(feed.symbol_map)} symbols on account")
    for cand in ("XAUUSD", "XAGUSD", "EURUSD", "US30"):
        r = feed.resolve_symbol(cand)
        print(f"   resolve {cand:7} -> {r}")
    print("\nFetching XAUUSD H1 (last 5 bars):")
    df = get_trendbars("XAUUSD", "1h", count=5)
    if df is None:
        print("  ⚠️ no bars returned (market closed / symbol unavailable)")
    else:
        for _, row in df.iterrows():
            t = time.strftime("%Y-%m-%d %H:%M", time.gmtime(row["timestamp"] / 1000))
            print(
                f"  {t}  O {row['open']:.2f}  H {row['high']:.2f}  "
                f"L {row['low']:.2f}  C {row['close']:.2f}  V {row['volume']:.0f}"
            )
    feed.close()
