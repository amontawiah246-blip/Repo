"""Deriv provider for the QuantX bridge (new Deriv API, developers.deriv.com).

Two independent connections, so market data never depends on your token:

1. MARKET DATA  -> wss://api.derivws.com/trading/v1/options/ws/public
   No token, no app id. Ticks, candles, active symbols. Auto-reconnects and
   re-subscribes every symbol that has a listener.

2. ACCOUNT (optional) -> PAT + Deriv-App-ID -> REST OTP -> authenticated WebSocket
   Only used for balance (and later, trading). If it fails, `auth_error` is set
   and the market data keeps streaming.

Config (environment variables, never hard-code a token in source):
    DERIV_TOKEN       your pat_... token            (or DERIV_API_KEY)
    DERIV_APP_ID      App ID of the PAT app you registered at developers.deriv.com
    DERIV_ACCOUNT_ID  optional; demo account is auto-picked if omitted

The credentials box in the UI also accepts  "pat_xxx|APP_ID|ACCOUNT_ID"
(the last two parts are optional).
"""
import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional

log = logging.getLogger("deriv")
log.setLevel(logging.INFO)
now = time.time

PUBLIC_WS = os.environ.get(
    "DERIV_PUBLIC_WS", "wss://api.derivws.com/trading/v1/options/ws/public")
REST_BASE = os.environ.get("DERIV_REST_BASE", "https://api.derivws.com")
SESSION_FILE = "/tmp/deriv_token.txt"

DERIV_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Origin": "https://app.deriv.com",
}

# Granularities Deriv accepts for style=candles. Anything else (5s, 10s, 15s...)
# is built locally from tick history.
CANDLE_GRANULARITIES = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400}

# Only used until the live active_symbols list arrives.
FALLBACK_ASSETS = [
    {"symbol": s, "name": n, "payout": 0, "active": True}
    for s, n in [
        ("R_10", "Volatility 10 Index"), ("R_25", "Volatility 25 Index"),
        ("R_50", "Volatility 50 Index"), ("R_75", "Volatility 75 Index"),
        ("R_100", "Volatility 100 Index"),
        ("1HZ10V", "Volatility 10 (1s) Index"), ("1HZ25V", "Volatility 25 (1s) Index"),
        ("1HZ50V", "Volatility 50 (1s) Index"), ("1HZ75V", "Volatility 75 (1s) Index"),
        ("1HZ100V", "Volatility 100 (1s) Index"),
        ("frxEURUSD", "EUR/USD"), ("frxGBPUSD", "GBP/USD"), ("frxUSDJPY", "USD/JPY"),
        ("frxXAUUSD", "Gold/USD"), ("cryBTCUSD", "BTC/USD"), ("cryETHUSD", "ETH/USD"),
    ]
]


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class DerivError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class DerivProvider:
    name = "deriv"

    def __init__(self):
        token = os.environ.get("DERIV_TOKEN", os.environ.get("DERIV_API_KEY", "")).strip()
        if not token and os.path.exists(SESSION_FILE):
            try:
                token = open(SESSION_FILE).read().strip()
            except Exception:
                pass
        self.token = ""
        self.app_id = os.environ.get("DERIV_APP_ID", "").strip()
        self.account_id = os.environ.get("DERIV_ACCOUNT_ID", "").strip()
        if token:
            self._parse_credentials(token)
        print("[Bridge] DerivProvider initialized")

        self.ready = False            # market-data socket is open
        self.error = ""               # market-data problem (shown by the server)
        self.auth_error = ""          # account/balance problem (separate on purpose)
        self.balance: Optional[float] = None
        self.is_demo = True           # which kind of account is in use (set once the account is picked)
        self.currency = "USD"
        self.assets: List[dict] = list(FALLBACK_ASSETS)
        self._assets_at = 0.0

        self._ws = None
        self._connected = asyncio.Event()
        self._main_task: Optional[asyncio.Task] = None
        self._auth_task: Optional[asyncio.Task] = None
        self._auth_ws = None                  # authorised account socket (balance + trading)
        self._auth_pending: Dict[int, asyncio.Future] = {}
        self._trade_rid = 1000                # request ids for account-socket calls (1 is the balance subscription)
        self._bg: set = set()
        self._subs: Dict[str, set] = {}       # symbol -> queues
        self._sub_ids: Dict[str, str] = {}    # symbol -> subscription id (per connection)
        self._pending: Dict[int, asyncio.Future] = {}
        self._req_id = 0

    # ------------------------------------------------------------------ config
    @property
    def configured(self) -> bool:
        # Public market data needs no token, so the provider is always usable.
        return True

    def _parse_credentials(self, raw: str):
        parts = [p.strip() for p in raw.split("|")]
        if parts[0]:
            self.token = parts[0]
        if len(parts) > 1 and parts[1]:
            self.app_id = parts[1]
        if len(parts) > 2 and parts[2]:
            self.account_id = parts[2]

    def set_credentials(self, email="", password="", ssid=""):
        raw = (ssid or email or "").strip()
        if raw:
            self._parse_credentials(raw)
            try:
                with open(SESSION_FILE, "w") as f:
                    f.write(raw)
                os.chmod(SESSION_FILE, 0o600)
            except Exception:
                pass
        self.auth_error = ""
        self.balance = None
        # Only the account connection restarts; market data keeps streaming.
        if self._auth_task and not self._auth_task.done():
            self._auth_task.cancel()
        self._auth_task = None

    # --------------------------------------------------------------- lifecycle
    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        return t

    def _ensure_tasks(self):
        if self._main_task is None or self._main_task.done():
            self._main_task = asyncio.ensure_future(self._run())
        if self.token and (self._auth_task is None or self._auth_task.done()):
            if not self.app_id:
                self.auth_error = ("PAT needs a Deriv App ID: set DERIV_APP_ID, or enter "
                                   "'pat_xxx|APP_ID' in the token box")
            else:
                self._auth_task = asyncio.ensure_future(self._auth_run())

    async def connect(self):
        self._ensure_tasks()
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        return self

    async def close(self):
        for t in (self._main_task, self._auth_task):
            if t and not t.done():
                t.cancel()
        for q_set in self._subs.values():
            for q in list(q_set):
                self._put(q, None)

    # ------------------------------------------------- market-data connection
    async def _run(self):
        try:
            import websockets
        except ImportError:
            self.error = "Python package 'websockets' is missing: pip install websockets"
            log.error(self.error)
            return

        backoff = 1.0
        while True:
            try:
                log.info("connecting to %s", PUBLIC_WS)
                async with websockets.connect(
                    PUBLIC_WS, open_timeout=10, ping_interval=20, ping_timeout=20, max_size=None
                ) as ws:
                    self._ws = ws
                    self._sub_ids.clear()
                    self.ready = True
                    self.error = ""
                    self._connected.set()
                    backoff = 1.0
                    log.info("market data connected")
                    await self._resubscribe()
                    self._spawn(self._refresh_assets())
                    async for raw in ws:
                        self._handle(raw)
                log.warning("market data socket closed by server")
                self.error = "Deriv market data socket closed, reconnecting"
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[Bridge] Deriv connection error: {e!r}")
                self.error = f"Deriv market data connection failed: {e!r}"
                log.warning(self.error)
            finally:
                self._ws = None
                self.ready = False
                self._connected.clear()
                self._fail_pending(ConnectionError("Deriv socket dropped"))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def _fail_pending(self, exc: Exception):
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    def _handle(self, raw):
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="ignore")
        try:
            data = json.loads(raw)
        except ValueError:
            return
        req_id = data.get("req_id")
        err = data.get("error")

        fut = self._pending.get(req_id) if req_id is not None else None
        if fut is not None:
            if not fut.done():
                if err:
                    fut.set_exception(DerivError(err.get("code", "Error"), err.get("message", "")))
                else:
                    fut.set_result(data)
            return

        if err:
            # e.g. a bad symbol on a tick subscription: make it visible instead of silent
            echo = data.get("echo_req", {})
            self.error = f"Deriv: {err.get('code')}: {err.get('message')} (request: {json.dumps(echo)[:120]})"
            log.warning(self.error)
            return

        tick = data.get("tick")
        if data.get("msg_type") == "tick" and isinstance(tick, dict):
            sym = tick.get("symbol") or tick.get("underlying_symbol")
            sub = data.get("subscription")
            if sym and isinstance(sub, dict) and sub.get("id"):
                self._sub_ids[sym] = sub["id"]
            price = _num(tick.get("quote"))
            ts = _num(tick.get("epoch")) or now()
            if sym and price is not None:
                for q in list(self._subs.get(sym, ())):
                    self._put(q, (ts, price))

    @staticmethod
    def _put(q: asyncio.Queue, item):
        if q.full():
            try:
                q.get_nowait()
            except Exception:
                pass
        try:
            q.put_nowait(item)
        except Exception:
            pass

    async def _send(self, payload: dict):
        ws = self._ws
        if ws is None:
            raise ConnectionError("Deriv market data socket is not connected")
        await ws.send(json.dumps(payload))

    async def _request(self, payload: dict, timeout: float = 15):
        if not self._connected.is_set():
            await asyncio.wait_for(self._connected.wait(), timeout=timeout)
        self._req_id += 1
        rid = self._req_id
        payload = dict(payload, req_id=rid)
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._send(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(rid, None)

    async def _resubscribe(self):
        for sym in list(self._subs):
            await self._subscribe(sym)

    async def _subscribe(self, sym: str):
        try:
            await self._send({"ticks": sym, "subscribe": 1})
        except Exception as e:
            log.warning("subscribe %s failed: %r (will retry on reconnect)", sym, e)

    async def _forget(self, sym: str):
        sid = self._sub_ids.pop(sym, None)
        if sid:
            try:
                await self._send({"forget": sid})
            except Exception:
                pass

    # ------------------------------------------------------------- public API
    async def _refresh_assets(self):
        try:
            res = await self._request({"active_symbols": "brief"}, timeout=15)
            parsed = []
            for s in res.get("active_symbols", []):
                sym = s.get("underlying_symbol") or s.get("symbol")
                if not sym:
                    continue
                suspended = bool(s.get("is_trading_suspended"))
                open_now = s.get("exchange_is_open")
                parsed.append({
                    "symbol": sym,
                    "name": s.get("underlying_symbol_name") or s.get("display_name") or sym,
                    "payout": 0,  # payout depends on contract/duration; fetch via proposal when trading
                    "active": (not suspended) and (open_now is None or bool(open_now)),
                    "market": s.get("market", ""),
                })
            if parsed:
                self.assets = parsed
                self._assets_at = now()
                log.info("loaded %d active symbols", len(parsed))
        except Exception as e:
            log.warning("active_symbols failed: %r (keeping fallback list)", e)

    async def list_assets(self) -> List[dict]:
        if not self.ready:
            await self.connect()
        if self.ready and now() - self._assets_at > 600:
            await self._refresh_assets()
        return self.assets

    async def ticks(self, asset: str):
        """Yield (epoch, price). Survives reconnects: the symbol is re-subscribed automatically."""
        await self.connect()
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        first = asset not in self._subs
        self._subs.setdefault(asset, set()).add(q)
        if first and self._ws is not None:
            await self._subscribe(asset)
        try:
            last_ts = 0.0
            while True:
                item = await q.get()
                if item is None:
                    break
                ts, price = item
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
                    await self._forget(asset)

    async def candles(self, asset: str, tf: int, window: int) -> List[dict]:
        tf = int(tf)
        try:
            await self.connect()
            if not self.ready:
                return []
            rows = []  # (time, open, high, low, close)
            if tf in CANDLE_GRANULARITIES:
                count = max(1, min(1000, int(window // tf) + 1))
                res = await self._request({
                    "ticks_history": asset, "adjust_start_time": 1, "count": count,
                    "end": "latest", "granularity": tf, "style": "candles"})
                for c in res.get("candles", []):
                    rows.append((_num(c.get("epoch")), _num(c.get("open")), _num(c.get("high")),
                                 _num(c.get("low")), _num(c.get("close"))))
            else:
                # sub-minute or odd timeframe: build it from tick history
                count = max(10, min(5000, int(window // max(1, tf // 2)) + 1))
                res = await self._request({
                    "ticks_history": asset, "adjust_start_time": 1, "count": count,
                    "end": "latest", "style": "ticks"})
                hist = res.get("history", {})
                buckets: Dict[int, list] = {}
                for t, p in zip(hist.get("times", []), hist.get("prices", [])):
                    t, p = _num(t), _num(p)
                    if t is None or p is None:
                        continue
                    k = int(t // tf * tf)
                    b = buckets.get(k)
                    if b is None:
                        buckets[k] = [p, p, p, p]
                    else:
                        b[1] = max(b[1], p)
                        b[2] = min(b[2], p)
                        b[3] = p
                rows = [(k, v[0], v[1], v[2], v[3]) for k, v in buckets.items()]

            out = {}
            for t, o, h, l, c in rows:
                if t is None or o is None or c is None:
                    continue
                k = int(t // tf * tf)
                out[k] = {"time": k, "open": o,
                          "high": h if h is not None else max(o, c),
                          "low": l if l is not None else min(o, c),
                          "close": c}
            return [out[k] for k in sorted(out)]
        except Exception as e:
            log.warning("candles(%s, %s) failed: %r", asset, tf, e)
            return []

    # ------------------------------------------- account connection (optional)
    @staticmethod
    def _http(method: str, url: str, token: str, app_id: str):
        req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
        req.add_header("Authorization", f"Bearer {token}")
        if app_id:
            req.add_header("Deriv-App-ID", app_id)
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", "QuantX-Bridge/1.0")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")[:300]
            raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from None

    @staticmethod
    def _pick_account(payload) -> str:
        items = payload.get("data") if isinstance(payload, dict) else payload
        if isinstance(items, dict):
            items = items.get("accounts") or [items]
        best = ""
        for it in items or []:
            if not isinstance(it, dict):
                continue
            aid = it.get("account_id") or it.get("id") or it.get("loginid")
            if not aid:
                continue
            if "demo" in json.dumps(it).lower():
                return str(aid)  # a bot should default to demo
            best = best or str(aid)
        return best

    @staticmethod
    def _accounts(payload):
        """[(account_id, is_demo)] from the accounts response."""
        items = payload.get("data") if isinstance(payload, dict) else payload
        if isinstance(items, dict):
            items = items.get("accounts") or [items]
        out = []
        for it in items or []:
            if isinstance(it, dict):
                aid = it.get("account_id") or it.get("id") or it.get("loginid")
                if aid:
                    out.append((str(aid), "demo" in json.dumps(it).lower()))
        return out

    async def set_account(self, demo: bool) -> str:
        """Switch between the demo and the real account (the next login uses it). Returns an error text or ''."""
        res = await asyncio.to_thread(
            self._http, "GET", f"{REST_BASE}/trading/v1/options/accounts", self.token, self.app_id)
        pick = next((a for a, d in self._accounts(res) if d == demo), "")
        if not pick:
            return "No Deriv demo account found on this token" if demo else "No Deriv real account found on this token"
        self.account_id, self.is_demo, self.balance = pick, demo, None
        if self._auth_task:
            self._auth_task.cancel()
            self._auth_task = None
        self._ensure_tasks()
        return ""

    async def _get_otp_url(self) -> str:
        if not self.account_id:
            res = await asyncio.to_thread(
                self._http, "GET", f"{REST_BASE}/trading/v1/options/accounts", self.token, self.app_id)
            self.account_id = self._pick_account(res)
            self.is_demo = dict(self._accounts(res)).get(self.account_id, True)
            if not self.account_id:
                raise RuntimeError("could not find an account id; set DERIV_ACCOUNT_ID. Response: "
                                   + json.dumps(res)[:200])
            log.info("using Deriv account %s", self.account_id)
        res = await asyncio.to_thread(
            self._http, "POST",
            f"{REST_BASE}/trading/v1/options/accounts/{self.account_id}/otp", self.token, self.app_id)
        url = (res.get("data") or {}).get("url")
        if not url:
            raise RuntimeError("OTP response had no url: " + json.dumps(res)[:200])
        return url

    async def _auth_run(self):
        import websockets
        backoff = 5.0

        while True:
            if not self.token or self.token.startswith("MY_") or self.token.strip() == "":
                self.auth_error = "Deriv API token not configured"
                await asyncio.sleep(15)
                continue

            try:
                url = await self._get_otp_url()
                async with websockets.connect(
                    url, open_timeout=10, ping_interval=20, ping_timeout=20, max_size=None
                ) as ws:
                    self._auth_ws = ws
                    self.auth_error = ""
                    backoff = 5.0
                    log.info("Deriv authenticated socket connected: %s", self.account_id)

                    # Subscribe to live balance updates
                    await ws.send(json.dumps({"balance": 1, "subscribe": 1, "req_id": 1}))

                    async for raw in ws:
                        d = json.loads(raw)
                        rid = d.get("req_id", 0)
                        fut = self._auth_pending.get(rid) if rid >= 1000 else None
                        if fut is not None:
                            if not fut.done():
                                fut.set_result(d)
                            continue

                        if d.get("error"):
                            err_m = f"{d['error'].get('code')}: {d['error'].get('message')}"
                            log.warning("account socket message error: %s", err_m)
                            continue

                        b = d.get("balance")
                        if isinstance(b, dict):
                            self.balance = _num(b.get("balance"))
                            self.currency = b.get("currency", self.currency)

            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.auth_error = f"Deriv account login error: {e}"
                log.warning(self.auth_error)
            finally:
                self._auth_ws = None
                for f in list(self._auth_pending.values()):
                    if not f.done():
                        f.set_exception(ConnectionError("Deriv account connection dropped"))

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    # ---------------------------------------------------------------- trading
    async def _auth_request(self, payload: dict, timeout: float = 15):
        ws = self._auth_ws
        if ws is None:
            raise RuntimeError("Deriv account is not connected" + (f" ({self.auth_error})" if self.auth_error
                               else ". Add your Deriv token on the API screen."))
        self._trade_rid += 1
        rid = self._trade_rid
        fut = asyncio.get_running_loop().create_future()
        self._auth_pending[rid] = fut
        try:
            await ws.send(json.dumps(dict(payload, req_id=rid)))
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._auth_pending.pop(rid, None)

    async def trade(self, asset: str, side: str, amount: float, seconds: int) -> dict:
        """Rise/Fall contract: price it with a proposal, then buy exactly that proposal."""
        base = {"proposal": 1, "amount": amount, "basis": "stake", "currency": self.currency,
                "contract_type": "CALL" if side == "buy" else "PUT",
                "duration": int(seconds), "duration_unit": "s"}
        res = {}
        for key in ("underlying_symbol", "symbol"):      # newer API name first, older name as a fallback
            res = await self._auth_request(dict(base, **{key: asset}))
            if res.get("error", {}).get("code") != "InputValidationFailed":
                break
        if res.get("error"):
            raise DerivError(res["error"].get("code", "error"), res["error"].get("message", "Proposal failed"))
        prop = res["proposal"]
        res = await self._auth_request({"buy": prop["id"], "price": float(prop["ask_price"])})
        if res.get("error"):
            raise DerivError(res["error"].get("code", "error"), res["error"].get("message", "Buy failed"))
        b = res.get("buy", {})
        return {"id": b.get("contract_id"), "stake": _num(b.get("buy_price")), "payout": _num(b.get("payout"))}

    async def trade_result(self, contract_id: str, timeout: float = 120) -> dict:
        """Poll the contract until it is sold (expired) and report the official outcome."""
        end = now() + timeout
        while now() < end:
            res = await self._auth_request({"proposal_open_contract": 1, "contract_id": int(contract_id)}, timeout=15)
            if res.get("error"):
                raise DerivError(res["error"].get("code", "error"), res["error"].get("message", "Contract lookup failed"))
            c = res.get("proposal_open_contract", {})
            if c.get("is_sold") or c.get("status") in ("won", "lost"):
                return {"result": c.get("status"), "profit": _num(c.get("profit"))}
            await asyncio.sleep(2)
        raise asyncio.TimeoutError()
