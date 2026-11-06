"""Quotex provider for QuantX bridge.
Connects to Quotex over WebSocket using curl_cffi browser impersonation to bypass Cloudflare.
Streams real-time market data (ticks, candles, payouts, balance) for Quotex assets.
"""
import asyncio
import json
import os
import re
import time
from typing import Dict, List, Optional, Tuple

now = time.time

SESSION_FILE = "/tmp/quotex_ssid.txt"
DEFAULT_SESSION = "QYezx7eGMKAnf3JSOzoPqU0YJER6vpsFHqNi0D4w"
WS_URL = "wss://ws2.quotex.com/socket.io/?EIO=4&transport=websocket"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class QuotexProvider:
    name = "quotex"

    def __init__(self):
        # Load token from env, file, or default
        token = os.environ.get("QUOTEX_SSID", os.environ.get("QUOTEX_SESSION", "")).strip()
        if not token and os.path.exists(SESSION_FILE):
            try:
                token = open(SESSION_FILE).read().strip()
            except Exception:
                pass
        self.session_token = token or DEFAULT_SESSION
        self.email = os.environ.get("QUOTEX_EMAIL", "").strip()
        self.password = os.environ.get("QUOTEX_PASSWORD", "").strip()

        self.ready = False
        self.error = ""
        self.balance: Optional[float] = None
        self.is_demo = True          # a fresh connection always starts on the demo account
        self.assets: List[dict] = []
        self.client = None

        self._lock = asyncio.Lock()
        self._subs: Dict[str, set] = {}  # asset -> set of asyncio.Queue
        self._raw_instruments: list = []

    @property
    def configured(self) -> bool:
        return bool(self.session_token or (self.email and self.password))

    def set_credentials(self, email="", password="", ssid=""):
        if ssid:
            self.session_token = ssid.strip()
            try:
                open(SESSION_FILE, "w").write(self.session_token)
            except Exception:
                pass
        if email:
            self.email = email.strip()
        if password:
            self.password = password.strip()
        self.error = ""
        self._drop()

    def _drop(self):
        self.ready = False
        if self.client:
            c = self.client
            self.client = None
            try:
                asyncio.ensure_future(c.close())
            except Exception:
                pass
        self._wake()

    def _wake(self):
        """Notify all tick listeners when connection is dropped so charts reconnect."""
        for q_set in self._subs.values():
            for q in list(q_set):
                if q.full():
                    try:
                        q.get_nowait()
                    except Exception:
                        pass
                q.put_nowait(None)

    def _on_tick(self, asset: str, ts: float, price: float):
        """Dispatch tick to all active queues for this asset."""
        queues = self._subs.get(asset)
        if queues:
            for q in list(queues):
                if q.full():
                    try:
                        q.get_nowait()
                    except Exception:
                        pass
                q.put_nowait((ts, price))

    async def connect(self):
        if self.ready and self.client:
            return self

        async with self._lock:
            if self.ready and self.client:
                return self

            if not self.configured:
                self.error = "Quotex session token not configured"
                return None

            try:
                from pyquotex.stable_api import Quotex
            except ImportError:
                try:
                    import sys
                    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                    from pyquotex.stable_api import Quotex
                except Exception as e:
                    self.error = f"Failed to load pyquotex: {e}"
                    return None

            self.error = ""
            try:
                client = Quotex(
                    email=self.email or "user@quotex.local",
                    password=self.password or "demo1234",
                    host="quotex.com",
                    wss_url_override=WS_URL
                )
                client.set_session(
                    user_agent=USER_AGENT,
                    ssid=self.session_token
                )

                ok, reason = await client.connect()
                if not ok:
                    self.error = f"Quotex connection rejected: {reason}"
                    return None

                # Hook into raw message processing to capture price ticks with minimal latency
                orig_on_msg = client.api._on_message

                async def hooked_on_message(msg):
                    try:
                        await orig_on_msg(msg)
                    except Exception:
                        pass
                    try:
                        msg_str = msg.decode("utf-8", errors="ignore") if isinstance(msg, bytes) else str(msg)
                        start_idx = -1
                        for idx, char in enumerate(msg_str):
                            if char in ("[", "{"):
                                start_idx = idx
                                break
                        if start_idx != -1:
                            parsed = json.loads(msg_str[start_idx:])
                            if isinstance(parsed, list) and len(parsed) > 0 and isinstance(parsed[0], list):
                                item = parsed[0]
                                if len(item) >= 3:
                                    sym = str(item[0])
                                    raw_t = _num(item[1]) or now()
                                    raw_p = _num(item[2])
                                    if raw_p is not None:
                                        self._on_tick(sym, raw_t, raw_p)
                    except Exception:
                        pass

                client.api._on_message = hooked_on_message

                # Retrieve instruments & payouts
                try:
                    raw_inst = await client.get_instruments()
                    self._raw_instruments = raw_inst or []
                    parsed_assets = []
                    for it in self._raw_instruments:
                        if isinstance(it, list) and len(it) >= 6:
                            sym = str(it[1])
                            name = str(it[2])
                            pay = int(it[5]) if it[5] is not None else 80
                            act = bool(it[14]) if len(it) > 14 and it[14] is not None else True
                            parsed_assets.append({
                                "symbol": sym,
                                "name": name,
                                "payout": pay,
                                "active": act
                            })
                    self.assets = parsed_assets
                except Exception as e:
                    self.assets = []

                # Retrieve balance
                try:
                    bal = await client.get_balance()
                    if bal is not None:
                        self.balance = float(bal)
                except Exception:
                    self.balance = None

                self.client = client
                self.ready = True
                self.is_demo = True
                return self

            except Exception as e:
                self.error = f"Quotex connection error: {e}"
                self._drop()
                return None

    async def list_assets(self) -> List[dict]:
        if not self.ready:
            await self.connect()
        return self.assets

    async def ticks(self, asset: str):
        """Async generator yielding (epoch_timestamp, price) for the requested asset."""
        if not self.ready:
            await self.connect()
        if not self.ready or not self.client:
            return

        q = asyncio.Queue(maxsize=1000)
        first_sub = asset not in self._subs
        self._subs.setdefault(asset, set()).add(q)

        try:
            if first_sub and self.client:
                # Start market depth stream
                await self.client.start_candles_stream(asset, 60)

            last_ts = 0.0
            while self.ready:
                item = await q.get()
                if item is None:
                    break
                ts, price = item
                if price is None:
                    continue
                # Normalize time to avoid clock drift
                if abs(ts - now()) > 120:
                    ts = now()
                ts = max(ts, last_ts)
                last_ts = ts
                yield ts, price

        finally:
            subs = self._subs.get(asset)
            if subs:
                subs.discard(q)
                if not subs:
                    self._subs.pop(asset, None)
                    if self.client and hasattr(self.client.api, "unfollow_candle"):
                        try:
                            await self.client.api.unfollow_candle(asset)
                        except Exception:
                            pass

    async def candles(self, asset: str, tf: int, window: int) -> List[dict]:
        """Fetch historical candles from Quotex broker."""
        if not self.ready:
            await self.connect()
        if not self.ready or not self.client:
            return []

        try:
            t = time.time()
            raw_candles = await self.client.get_candles(
                asset=asset,
                end_from_time=t,
                offset=int(window),
                period=int(tf),
                timeout=12
            )
            if not raw_candles:
                try:
                    if hasattr(self.client, "get_candle_v2"):
                        raw_candles = await self.client.get_candle_v2(asset, int(tf), timeout=8)
                except Exception:
                    pass

            if not raw_candles:
                return []

            out = {}
            for c in raw_candles:
                t_c, o, cl, h, l = None, None, None, None, None
                if isinstance(c, dict):
                    t_c = _num(c.get("time", c.get("t")))
                    o = _num(c.get("open", c.get("o")))
                    cl = _num(c.get("close", c.get("c")))
                    h = _num(c.get("high", c.get("h")))
                    l = _num(c.get("low", c.get("l")))
                elif isinstance(c, (list, tuple)) and len(c) >= 5:
                    t_c = _num(c[0])
                    o = _num(c[1])
                    cl = _num(c[2])
                    h = _num(c[3])
                    l = _num(c[4])

                if t_c is None or o is None or cl is None:
                    continue
                if t_c > 1e11:
                    t_c = t_c / 1000.0
                t_int = int(t_c // tf * tf)
                out[t_int] = {
                    "time": t_int,
                    "open": o,
                    "high": h if h is not None else max(o, cl),
                    "low": l if l is not None else min(o, cl),
                    "close": cl
                }
            return [out[k] for k in sorted(out)]
        except Exception:
            return []
