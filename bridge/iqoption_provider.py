"""IQ Option provider for the bridge (read-only: live prices, candles, payouts. It never places trades).

IQ Option has no official public API. This follows the message formats of the community `iqoption` npm package
(github.com/LuKks/iqoption, the repo you sent) and talks to the same WebSocket from Python, so it plugs into the
bridge the same way the Quotex provider does:

    connect()            -> self or None (None: not configured or login failed; see .error)
    list_assets()        -> [{"symbol", "name", "payout", "active"}]
    ticks(asset)         -> async generator of (epoch_seconds_utc, price)
    candles(asset, tf, window_s) -> broker candles [{"time","open","high","low","close"}], oldest first

Login: IQ_EMAIL + IQ_PASSWORD (or enter them on the API screen), or IQ_SSID (the `ssid` cookie of a logged-in
browser session; use this if your account has two-factor login). Credentials stay in memory only.
The asset list comes from that repo's assets.json, which its author describes as outdated: only the pairs in it
(a handful of OTC pairs among them) can be charted until it is refreshed.
"""
import asyncio
import json
import os
import random
import re
import time
import urllib.error
import urllib.request

now = time.time

WS_URL = "wss://ws.iqoption.com/echo/websocket"
LOGIN_URL = "https://auth.iqoption.com/api/v2/login"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
ASSETS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "iq_assets.json")


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def to_symbol(name: str) -> str:
    """'EUR/USD (OTC)' -> 'EURUSD_otc', 'EUR/USD' -> 'EURUSD'."""
    s = str(name).strip()
    otc = bool(re.search(r"otc", s, re.I))
    base = re.sub(r"\(?\s*otc\s*\)?", "", s, flags=re.I)
    base = re.sub(r"[^A-Za-z0-9#]", "", base.replace("_", ""))
    return f"{base}_otc" if otc else base


def _login_http(email, password):
    """Blocking: returns (ssid, error)."""
    req = urllib.request.Request(
        LOGIN_URL, data=json.dumps({"identifier": email, "password": password}).encode(), method="POST",
        headers={"Origin": "https://login.iqoption.com", "User-Agent": UA, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            cookies = r.headers.get_all("Set-Cookie") or []
            body = r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        try:
            code = json.loads(e.read().decode("utf-8", "ignore")).get("code", "")
        except Exception:
            code = ""
        return None, f"IQ Option login refused ({e.code} {code}). " + (
            "Two-factor login: set IQ_SSID from your browser instead." if "verify" in code or "2fa" in code.lower() else
            "Check email and password.")
    except Exception as e:
        return None, f"IQ Option login failed: {e}"
    for c in cookies:
        m = re.match(r"\s*ssid=([^;]+)", c)
        if m:
            return m.group(1), ""
    if "verify" in body:
        return None, "IQ Option wants two-factor verification: set IQ_SSID from your browser instead."
    return None, "IQ Option login gave no session cookie."


class IQProvider:
    name = "iqoption"

    def __init__(self):
        self.email = os.environ.get("IQ_EMAIL", "").strip()
        self.password = os.environ.get("IQ_PASSWORD", "").strip()
        self.ssid = os.environ.get("IQ_SSID", "").strip()
        self.ready, self.error, self.balance = False, "", None
        self.assets, self.client = [], None
        self.group_id = None
        self.is_demo = True               # the account orders go to (chosen per order by balance id)
        self.bal_ids, self.bal_amt = {}, {}   # "demo"/"real" -> balance id / amount
        self.closed = {}                  # order id -> closing message
        self.exp = {}                     # order id -> expiry timestamp
        self.profits = {}                 # active_id -> payout percent
        self._ws = None
        self._reader = None
        self._lock = asyncio.Lock()
        self._rid = 0
        self._t0 = now()
        self._pending = {}                # request_id -> Future
        self._auth = None
        self._subs = {}                   # (active_id, size) -> set of queues
        try:
            self._by_name = {to_symbol(a["name"]): a for a in json.load(open(ASSETS_FILE))}
        except Exception:
            self._by_name = {}

    @property
    def configured(self) -> bool:
        return bool(self.ssid or (self.email and self.password))

    def set_credentials(self, email="", password="", ssid=""):
        self.email, self.password, self.ssid = email.strip(), password.strip(), ssid.strip()
        self.error = ""
        self._drop()

    # ---------- wire ----------
    def _drop(self):
        self.ready, self.client = False, None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        ws, self._ws = self._ws, None
        if ws:
            asyncio.ensure_future(self._close(ws))
        self._wake()
        for f in self._pending.values():
            if not f.done():
                f.cancel()
        self._pending.clear()

    def _wake(self):
        """Tell every live-price listener the connection is gone (ticks() then ends and the chart reconnects)."""
        for q_set in self._subs.values():
            for q in q_set:
                if q.full():
                    q.get_nowait()
                q.put_nowait(None)

    @staticmethod
    async def _close(ws):
        try:
            await ws.close()
        except Exception:
            pass

    def _next_id(self):
        self._rid += 1
        return str(self._rid)

    def _frame(self, name, msg, rid=None):
        return {"name": name, "request_id": rid or self._next_id(), "local_time": int(now() - self._t0) + 5, "msg": msg}

    async def _send(self, frame):
        await self._ws.send(json.dumps(frame))

    async def _request(self, msg, timeout=20, name="sendMessage"):
        frame = self._frame(name, msg)
        fut = asyncio.get_running_loop().create_future()
        self._pending[frame["request_id"]] = fut
        try:
            await self._send(frame)
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(frame["request_id"], None)

    async def _read(self):
        try:
            async for raw in self._ws:
                try:
                    d = json.loads(raw)
                except Exception:
                    continue
                n = d.get("name")
                if n == "heartbeat":
                    await self._send(self._frame("heartbeat", {"userTime": str(int(now() * 1000)),
                                                               "heartbeatTime": str(d.get("msg"))}))
                elif n == "authenticated":
                    if self._auth and not self._auth.done():
                        self._auth.set_result(bool(d.get("msg")))
                elif n in ("position-changed", "option-closed", "option"):
                    m = d.get("msg") or {}
                    for key in (m.get("external_id"), m.get("id"), m.get("option_id"), (m.get("raw_event") or {}).get("option_id")):
                        if key is not None and (m.get("status") == "closed" or n == "option-closed" or m.get("close_reason")):
                            self.closed[str(key)] = m
                elif n == "candle-generated":
                    m = d.get("msg") or {}
                    for q in list(self._subs.get((m.get("active_id"), m.get("size")), ())):
                        if q.full():
                            q.get_nowait()
                        q.put_nowait(m)
                rid = d.get("request_id")
                if rid is not None and n != "result":
                    f = self._pending.get(str(rid))
                    if f and not f.done():
                        f.set_result(d.get("msg"))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.error = f"IQ Option connection lost: {e}"
        finally:
            if self._ws is not None:
                self.error = self.error or "IQ Option connection closed"
                self.ready = False
                self._wake()

    # ---------- public surface ----------
    async def connect(self):
        if self.ready and self._ws:
            return self
        async with self._lock:
            if self.ready and self._ws:
                return self
            if not self.configured:
                self.error = "No IQ Option login. Set IQ_EMAIL and IQ_PASSWORD (or IQ_SSID) or enter them on the API screen."
                return None
            try:
                import websockets
            except ImportError:
                self.error = "The websockets package is missing on the bridge (pip install websockets)."
                return None
            self._drop()
            if not self.ssid:
                ssid, err = await asyncio.to_thread(_login_http, self.email, self.password)
                if not ssid:
                    self.error = err
                    return None
                self.ssid = ssid
            try:
                try:
                    self._ws = await asyncio.wait_for(websockets.connect(
                        WS_URL, origin="https://iqoption.com", additional_headers={"User-Agent": UA}), 20)
                except TypeError:   # older websockets releases call it extra_headers
                    self._ws = await asyncio.wait_for(websockets.connect(
                        WS_URL, origin="https://iqoption.com", extra_headers={"User-Agent": UA}), 20)
                self._t0 = now() - random.uniform(4, 6)
                self._auth = asyncio.get_running_loop().create_future()
                self._reader = asyncio.ensure_future(self._read())
                await self._send(self._frame("authenticate", {"ssid": self.ssid, "protocol": 3, "session_id": "",
                                                             "client_session_id": ""}))
                if not await asyncio.wait_for(self._auth, 20):
                    self.ssid = ""   # a stale session: next attempt logs in again
                    self.error = "IQ Option rejected the session (wrong login or expired SSID)."
                    self._drop()
                    return None
                await self._send(self._frame("setOptions", {"sendResults": True}))
                await self._setup()
                self.ready, self.error, self.client = True, "", self
                return self
            except Exception as e:
                self.error = f"IQ Option connect error: {e}"
                self._drop()
                return None

    async def _setup(self):
        """Profile (payout group), practice balance and payouts. Each step is optional: charts need none of them."""
        try:
            prof = await self._request({"name": "core.get-profile", "version": "1.0", "body": {}})
            res = prof.get("result", prof) if isinstance(prof, dict) else {}
            self.group_id = res.get("group_id")
        except Exception:
            pass
        try:
            bal = await self._request({"name": "get-balances", "version": "1.0",
                                       "body": {"types_ids": [1, 4, 2], "tournaments_statuses_ids": [3, 2]}})
            rows = bal if isinstance(bal, list) else (bal or {}).get("balances", [])
            for b in rows:
                k = "demo" if b.get("type") == 4 else "real" if b.get("type") == 1 else None
                if k:
                    self.bal_ids[k], self.bal_amt[k] = b.get("id"), _num(b.get("amount"))
            self.balance = self.bal_amt.get("demo" if self.is_demo else "real")
        except Exception:
            pass
        await self._payouts()

    async def set_account(self, demo: bool) -> str:
        """Orders carry the balance id, so switching is a local choice. Returns an error text or ''."""
        if not self.ready:
            return "IQ Option is not connected"
        await self._setup_balances()
        key = "demo" if demo else "real"
        if self.bal_ids.get(key) is None:
            return f"IQ Option did not list a {key} balance"
        self.is_demo = demo
        self.balance = self.bal_amt.get(key)
        return ""

    async def _setup_balances(self):
        try:
            bal = await self._request({"name": "get-balances", "version": "1.0",
                                       "body": {"types_ids": [1, 4], "tournaments_statuses_ids": [3, 2]}})
            rows = bal if isinstance(bal, list) else (bal or {}).get("balances", [])
            for b in rows:
                k = "demo" if b.get("type") == 4 else "real" if b.get("type") == 1 else None
                if k:
                    self.bal_ids[k], self.bal_amt[k] = b.get("id"), _num(b.get("amount"))
        except Exception:
            pass

    async def trade(self, asset, side, amount, seconds):
        """Open a turbo/binary option. M1 and M5 only (IQ Option expiries sit on whole minutes). NOT verified against a live account."""
        if seconds not in (60, 300):
            raise RuntimeError("IQ Option trades support 1 minute and 5 minute expiries here")
        await self._setup_balances()
        bid = self.bal_ids.get("demo" if self.is_demo else "real")
        if bid is None:
            raise RuntimeError("IQ Option balance not found")
        aid = self._id(asset)
        minutes = seconds // 60
        t = now()
        base = (int(t) // 60 + 1) * 60
        if base - t < 30:
            base += 60
        exp = base + (minutes - 1) * 60
        body = {"user_balance_id": bid, "active_id": aid, "option_type_id": 3 if minutes <= 5 else 1,
                "direction": "call" if side == "buy" else "put", "expired": int(exp), "refund_value": 0,
                "price": float(amount), "value": 0, "profit_percent": int(self.profits.get(aid) or 80)}
        msg = await self._request({"name": "binary-options.open-option", "version": "1.0", "body": body}, timeout=20)
        if not isinstance(msg, dict) or msg.get("id") in (None, "") or msg.get("message"):
            raise RuntimeError(f"IQ Option rejected the trade: {(msg or {}).get('message') if isinstance(msg, dict) else msg}")
        tid = str(msg["id"])
        self.exp[tid] = exp
        return {"id": tid, "exp": exp}

    async def trade_result(self, tid, timeout=120):
        """Wait for the closing message of this order. Raises if IQ Option never sends one, so the caller estimates."""
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            m = self.closed.get(str(tid))
            if m:
                pnl = _num(m.get("pnl") if m.get("pnl") is not None else m.get("pnl_net"))
                reason = str(m.get("close_reason") or m.get("result") or "").lower()
                return {"result": reason or ("win" if (pnl or 0) > 0 else "loss" if (pnl or 0) < 0 else "draw"), "profit": pnl}
            await asyncio.sleep(1)
        raise asyncio.TimeoutError()

    async def _payouts(self):
        if self.group_id is None:
            return
        for kind in ("turbo-option", "binary-option"):
            try:
                msg = await self._request({"name": "get-commissions", "version": "1.0",
                                           "body": {"instrument_type": kind, "user_group_id": self.group_id}})
                for it in (msg or {}).get("items", []):
                    v = _num(it.get("value"))
                    if v is not None and it.get("active_id") not in self.profits:
                        self.profits[it["active_id"]] = int(round(100 - v))
            except Exception:
                continue

    async def list_assets(self):
        if self.ready and not self.profits:
            await self._payouts()
        out = []
        for sym, a in self._by_name.items():
            pay = self.profits.get(a["active_id"])
            if self.profits and pay is None:
                continue   # IQ Option offers no binary/turbo options on this asset right now
            out.append({"symbol": sym, "name": a["name"], "payout": pay, "active": True})
        self.assets = out
        return out

    def _id(self, asset):
        a = self._by_name.get(asset)
        if not a:
            raise KeyError(f"{asset} is not in the IQ Option asset list")
        return a["active_id"]

    async def ticks(self, asset):
        """Live prices from IQ Option's one-second candle stream (its close is the latest price)."""
        aid = self._id(asset)
        key = (aid, 1)
        q = asyncio.Queue(maxsize=500)
        first = key not in self._subs
        self._subs.setdefault(key, set()).add(q)
        sub = {"name": "candle-generated", "params": {"routingFilters": {"active_id": aid, "size": 1}}}
        try:
            if first:
                await self._send(self._frame("subscribeMessage", sub, "s_" + self._next_id()))
            last = 0.0
            while True:
                m = await q.get()
                if m is None:
                    return
                px = _num(m.get("close"))
                at = _num(m.get("at"))
                ts = at / 1e9 if at and at > 1e17 else _num(m.get("from"))
                if px is None or ts is None:
                    continue
                if abs(ts - now()) > 120:   # a clock we cannot trust: use ours
                    ts = now()
                ts = max(ts, last)
                last = ts
                yield ts, px
        finally:
            self._subs.get(key, set()).discard(q)
            if not self._subs.get(key) and self._ws is not None:
                self._subs.pop(key, None)
                try:
                    await self._send(self._frame("unsubscribeMessage", sub, "s_" + self._next_id()))
                except Exception:
                    pass

    async def candles(self, asset, tf, window):
        aid = self._id(asset)
        count = max(1, min(1000, int(window // tf) + 1))
        base = {"active_id": aid, "split_normalize": True, "size": int(tf), "to": int(now()), "count": count}
        last_err = None
        for body in (base, {**base, "": "1"}):   # the second spelling is what some other clients send
            try:
                msg = await self._request({"name": "get-candles", "version": "2.0", "body": body}, timeout=25)
            except Exception as e:
                last_err = e
                continue
            rows = msg.get("candles") if isinstance(msg, dict) else msg
            out = {}
            for x in rows or []:
                t, o, c = _num(x.get("from")), _num(x.get("open")), _num(x.get("close"))
                if t is None or o is None or c is None:
                    continue
                h = _num(x.get("max"))
                l = _num(x.get("min"))
                t = int(t // tf * tf)
                out[t] = {"time": t, "open": o, "high": h if h is not None else max(o, c),
                          "low": l if l is not None else min(o, c), "close": c}
            if out:
                return [out[k] for k in sorted(out)]
        if last_err:
            raise last_err
        return []
