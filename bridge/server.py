"""Pocket Option bridge: SSID -> BinaryOptionsToolsV2 -> HTTP/WebSocket for the dashboard. Real data only.

How the candles are built (and why):

1. The broker's history endpoints use the BROKER's clock (UTC+2 when tested) while live ticks are normalised to UTC
   by the library. We measure the broker offset, ask for history in broker time and convert labels back to UTC.
2. The broker publishes closed candles late, sometimes by minutes, and sometimes skips a minute inside the window.
   So the bridge also records every live tick itself (Recorder, 5-second candles, each open chained to the previous
   close like the broker's own candles). Our ticks are never behind, so they fill whatever the broker has not
   published yet. Broker candles win as soon as they exist.
3. A Book holds everything a chart has been shown. Merges only add or correct candles and never drop any, so a late
   or stale history response can no longer open a hole at the right edge (this was the main source of gaps).
4. If holes remain after opening or after a minute rolls, the bridge retries the history fetch a few times until the
   broker catches up.
5. History is verified against the live price using broker candles only (tick-built candles always agree with the
   live price, so they cannot be used for that check).
"""
import asyncio, json, os, time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
try:
    from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync
except Exception:
    class PocketOptionAsync:
        def __init__(self, *args, **kwargs): pass
        async def connect(self): return False
        async def close(self): pass

try:
    try:
        from .iqoption_provider import IQProvider
    except ImportError:
        from iqoption_provider import IQProvider
except Exception:
    class IQProvider:
        name = "iqoption"
        configured = False
        ready = False
        error = "IQ Option not configured"
        balance = None
        assets = []
        async def connect(self): return None
        async def list_assets(self): return []
        async def ticks(self, asset):
            if False: yield (0, 0.0)
        async def candles(self, asset, tf, window_s): return []
        def set_credentials(self, email, password, ssid=""): pass

try:
    try:
        from .quotex_provider import QuotexProvider
    except ImportError:
        from quotex_provider import QuotexProvider
except Exception:
    class QuotexProvider:
        name = "quotex"
        configured = False
        ready = False
        error = "Quotex not configured"
        balance = None
        assets = []
        async def connect(self): return None
        async def list_assets(self): return []
        async def ticks(self, asset):
            if False: yield (0, 0.0)
        async def candles(self, asset, tf, window_s): return []
        def set_credentials(self, email, password, ssid=""): pass

try:
    try:
        from .deriv_provider import DerivProvider
    except ImportError:
        from deriv_provider import DerivProvider
except Exception:
    class DerivProvider:
        name = "deriv"
        configured = False
        ready = False
        error = "Deriv not configured"
        balance = None
        assets = []
        async def connect(self): return None
        async def list_assets(self): return []
        async def ticks(self, asset):
            if False: yield (0, 0.0)
        async def candles(self, asset, tf, window_s): return []
        def set_credentials(self, email, password, ssid=""): pass

now = time.time          # module-level so tests can run on a simulated clock
sleep = asyncio.sleep

SESSION_FILE = "/tmp/pocket_ssid.txt"
SSID = os.environ.get("POCKET_SSID", "").strip()
if not SSID and os.path.exists(SESSION_FILE):
    try:
        SSID = open(SESSION_FILE).read().strip()
    except Exception:
        pass
S = {"client": None, "ready": False, "error": "", "balance": None, "assets": []}
_lock = asyncio.Lock()
feeds = {}
recs = {}
ROWS = 300
MAX_GAP_PCT = 0.2          # broker history vs live price tolerance, percent
FINE = 5                   # seconds per recorded candle
FINE_KEEP = 6 * 3600 // FINE
CHAIN_MAX_GAP = 20         # seconds without ticks after which a new candle no longer chains to the old close
IDLE_KEEP_S = 900          # keep recording an asset this long after the last chart closes
DEFAULT_ASSET = "1HZ100V"

DERIV = DerivProvider()    # Deriv (PAT token API)
QX = QuotexProvider()      # Quotex
IQ = IQProvider()          # IQ Option
PROVIDERS = {"deriv": DERIV, "quotex": QX, "iqoption": IQ}
BROKERS = ("deriv", "pocket", "quotex", "iqoption")


def bk(v):
    return "deriv"



def fkey(broker, asset):
    """Feeds and recorders are per broker AND asset, so two brokers never mix their prices."""
    return f"{broker}:{asset}"
FINE_FETCH_MAX = 4 * 3600  # the broker's 5-second history only reaches back this far
REPAIR_MAX = int(3.5 * 3600)


def lib_version():
    try:
        from importlib.metadata import version
        for n in ("BinaryOptionsToolsV2", "binaryoptionstoolsv2"):
            try:
                return version(n)
            except Exception:
                pass
    except Exception:
        pass
    return "unknown"


def to_epoch(v) -> float:
    if v is None:
        return now()
    if isinstance(v, datetime):
        return v.timestamp()
    try:
        v = float(v)
        return v / 1000 if v > 1e11 else v
    except (TypeError, ValueError):
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()


def field(d, *names):
    for n in names:
        v = d.get(n) if isinstance(d, dict) else getattr(d, n, None)
        if v is not None:
            return v
    return None


def norm(c):
    return {"time": int(to_epoch(field(c, "timestamp", "time"))), "open": float(field(c, "open")),
            "high": float(field(c, "high")), "low": float(field(c, "low")), "close": float(field(c, "close"))}


def utc(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S")


async def connect() -> Optional[PocketOptionAsync]:
    if S["ready"] and S["client"]:
        return S["client"]
    async with _lock:
        if S["ready"] and S["client"]:
            return S["client"]
        if not SSID:
            S["error"] = "No SSID set. Add POCKET_SSID or paste it on the API screen."
            return None
        try:
            c = PocketOptionAsync(ssid=SSID)
            await c.connect()
            await c.wait_for_assets()
            S["client"] = c
            S["assets"] = await c.active_assets()
            try:
                S["balance"] = float(await c.balance())
            except Exception:
                pass
            S["ready"], S["error"] = True, ""
            return c
        except Exception as e:
            S["error"] = str(e)
            return None


async def connect_broker(broker):
    return await (PROVIDERS[broker].connect() if broker in PROVIDERS else connect())


# ---------- tick recorder: our own 5-second candles, never behind the live feed ----------
class Recorder:
    def __init__(self):
        self.fine = {}     # 5 s bucket -> candle built from live ticks
        self.last = None   # (ts, price) of the newest tick
        self.since = None  # when recording began

    def add(self, ts, price):
        if self.since is None:
            self.since = ts
        newest = self.last is None or ts >= self.last[0]
        b = int(ts // FINE * FINE)
        c = self.fine.get(b)
        if c:
            c["high"], c["low"] = max(c["high"], price), min(c["low"], price)
            if newest:
                c["close"] = price
        else:
            prev = self.last[1] if self.last and 0 <= ts - self.last[0] <= CHAIN_MAX_GAP else price
            self.fine[b] = {"time": b, "open": prev, "high": max(prev, price), "low": min(prev, price), "close": price}
            if len(self.fine) > FINE_KEEP:
                for k in sorted(self.fine)[:len(self.fine) - FINE_KEEP]:
                    del self.fine[k]
        if newest:
            self.last = (ts, price)

    def candles(self):
        return [self.fine[t] for t in sorted(self.fine)]


def rec_for(k) -> Recorder:
    r = recs.get(k)
    if not r:
        r = recs[k] = Recorder()
    return r


# ---------- shared live feed: one Pocket Option subscription per asset ----------
class Feed:
    def __init__(self, asset, broker="pocket"):
        self.asset, self.broker, self.queues, self.task = asset, broker, set(), None
        self.reaper, self.pinned = None, False
        self.k = fkey(broker, asset)
        self.rec = rec_for(self.k)

    async def run_provider(self):
        prov = PROVIDERS[self.broker]
        if not await prov.connect():
            return
        async for ts, price in prov.ticks(self.asset):
            tick = (ts, price)
            self.rec.add(*tick)
            for q in list(self.queues):
                if q.full():
                    q.get_nowait()
                q.put_nowait(tick)

    async def run(self):
        try:
            if self.broker in PROVIDERS:
                await self.run_provider()
                return
            client = await connect()
            if not client:
                return
            stream = await client.subscribe_symbol(self.asset)
            async for item in stream:
                sym = field(item, "symbol", "asset")
                raw = field(item, "price", "close", "rate")
                if raw is None or (sym and sym != self.asset):
                    continue
                try:
                    raw_t = to_epoch(field(item, "timestamp", "time"))
                    diff = raw_t - now()
                    t_utc = (raw_t - round(diff / 900.0) * 900) if 3600 <= diff <= 14400 else raw_t
                    tick = (t_utc, float(raw))
                except Exception:
                    continue
                self.rec.add(*tick)
                for q in list(self.queues):
                    if q.full():
                        q.get_nowait()
                    q.put_nowait(tick)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            S["error"] = str(e)
        finally:
            for q in list(self.queues):
                if q.full():
                    q.get_nowait()
                q.put_nowait(None)
            if feeds.get(self.k) is self:
                feeds.pop(self.k, None)


def ensure_feed(asset, broker="pocket"):
    k = fkey(broker, asset)
    feed = feeds.get(k)
    if not feed:
        feed = feeds[k] = Feed(asset, broker)
        feed.task = asyncio.create_task(feed.run())
    if feed.reaper:
        feed.reaper.cancel()
        feed.reaper = None
    return feed


def attach(asset, broker="pocket"):
    feed = ensure_feed(asset, broker)
    q = asyncio.Queue(maxsize=2000)
    feed.queues.add(q)
    return feed, q


def reap(feed):
    feed.reaper = None
    if not feed.queues and not feed.pinned and feeds.get(feed.k) is feed:
        feeds.pop(feed.k, None)
        if feed.task:
            feed.task.cancel()


def detach(feed, q):
    feed.queues.discard(q)
    if not feed.queues and not feed.pinned and feeds.get(feed.k) is feed and not feed.reaper:
        # keep recording for a while: the next chart opens onto a warm recorder instead of a cold start
        feed.reaper = asyncio.get_running_loop().call_later(IDLE_KEEP_S, reap, feed)


async def keep_warm():
    """Record the default asset from the moment the bridge connects, and reconnect its feed if it dies."""
    while True:
        try:
            if await connect_broker("deriv"):
                f = ensure_feed(DEFAULT_ASSET, "deriv")
                f.pinned = True
                if f.task:
                    await asyncio.wait([f.task])
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await sleep(5)



# ---------- history in broker time ----------
async def measure_offset(client) -> int:
    """Broker clock minus UTC, rounded to a quarter hour. Needs at least one live tick to have arrived."""
    try:
        st = float(await client.get_server_time())
        off = int(round((st - now()) / 900.0)) * 900
        return off if abs(off) <= 14 * 3600 else 0
    except Exception:
        return 0


async def fetch(client, asset, period, window, off, end_utc=None):
    """Candles for the window ending at end_utc, asked for in broker time, labels converted back to UTC."""
    end = int(end_utc if end_utc is not None else now())
    raw = await asyncio.wait_for(client.client.get_candles_advanced(asset, period, int(window), end + off), 25)
    data = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    out = {}
    for x in data or []:
        try:
            c = norm(x)
            c["time"] -= off
            out[c["time"]] = c
        except Exception:
            continue
    return [out[t] for t in sorted(out)]


def aggregate(fine, tf, since, closed_at=None):
    """Roll sorted 5 s candles up to tf. With closed_at (a clock reading), a bucket that has already ended but has no
    5 s candle near its start or near its end is dropped: showing it would mean showing wrong highs, lows or close."""
    by, span = {}, {}
    for c in fine:
        b = c["time"] // tf * tf
        if b < since:
            continue
        a = by.get(b)
        if not a:
            by[b] = {"time": b, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]}
            span[b] = [c["time"], c["time"]]
        else:
            a["high"], a["low"], a["close"] = max(a["high"], c["high"]), min(a["low"], c["low"]), c["close"]
            span[b][1] = c["time"]
    out = []
    for b in sorted(by):
        if closed_at is not None and b + tf <= closed_at and (span[b][0] - b >= 2 * FINE or b + tf - span[b][1] > 2 * FINE):
            continue
        out.append(by[b])
    return out


def merge_fine(official, ticks, cutoff):
    """5 s candles from the broker plus our own. Broker wins once a 5 s candle has closed; our ticks fill what the
    broker has not published and finish the 5 s candle that is still forming."""
    out = {c["time"]: dict(c) for c in official}
    for c in ticks:
        o = out.get(c["time"])
        if o is None:
            out[c["time"]] = dict(c)
        elif c["time"] >= cutoff:
            o["high"], o["low"], o["close"] = max(o["high"], c["high"]), min(o["low"], c["low"]), c["close"]
    return [out[t] for t in sorted(out)]


def holes(times, tf, upto=None):
    """Bucket starts missing between the first candle and `upto` (exclusive; default: the newest candle)."""
    times = sorted(times)
    if not times:
        return []
    have = set(times)
    end = times[-1] if upto is None else upto
    return [t for t in range(times[0], end, tf) if t not in have]


async def build_history(client, asset, tf, off, rec=None):
    """Broker candles at tf, repaired and extended with 5-second broker candles and our own recorded ticks.
    Returns (candles, debug)."""
    t = now()
    main = await fetch(client, asset, tf, tf * ROWS, off)
    merged = {c["time"]: c for c in main}
    dbg = {"official_count": len(main), "official_newest": main[-1]["time"] if main else None,
           "fine5s_count": 0, "fine5s_newest": None, "check_close": main[-1]["close"] if main else None}
    newest = main[-1]["time"] if main else int(t // tf * tf) - tf * 3
    inner = [h for h in holes([c["time"] for c in main], tf) if t - h <= REPAIR_MAX]
    dbg["official_holes"] = len(inner)
    since = min([newest] + inner)

    ofine = []
    if tf == FINE:
        ofine = main
    elif t - since + 30 <= FINE_FETCH_MAX:
        window = int(t - since) + 30
        try:
            ofine = await fetch(client, asset, FINE, window, off)
            dbg.update(fine5s_count=len(ofine), fine5s_newest=ofine[-1]["time"] if ofine else None, fine5s_window_s=window)
        except Exception:
            pass
    if ofine:
        dbg["check_close"] = ofine[-1]["close"]

    ticks = rec.candles() if rec else []
    dbg.update(tick_count=len(ticks), tick_since=rec.since if rec else None,
               tick_newest=ticks[-1]["time"] if ticks else None)
    fine = merge_fine(ofine, ticks, int(t // FINE * FINE))
    for c in aggregate(fine, tf, since, t):
        merged.setdefault(c["time"], c)  # broker candle wins where both exist
    return [merged[k] for k in sorted(merged)], dbg


def disagreement(dbg, live_price):
    """Percent gap between the newest BROKER candle and the live price (None if the broker gave nothing)."""
    c = dbg.get("check_close")
    return None if c is None or not live_price else abs(c - live_price) / live_price * 100


async def history_checked(client, asset, tf, live_price, rec=None):
    """Build history; if broker candles disagree with the live price, try other clock offsets and keep the best."""
    off = await measure_offset(client)
    tried = {}
    for cand in [off] + [o for o in (7200, 0, 3600, -7200, 10800) if o != off]:
        try:
            cs, dbg = await build_history(client, asset, tf, cand, rec)
        except Exception:
            continue
        if not cs:
            continue
        gap = disagreement(dbg, live_price)
        if gap is None:
            return cand, 0.0, cs, dbg   # nothing from the broker to compare with: ticks only
        tried[cand] = (gap, cs, dbg)
        if gap <= MAX_GAP_PCT:
            return cand, gap, cs, dbg
    if tried:
        cand = min(tried, key=lambda k: tried[k][0])
        return cand, tried[cand][0], tried[cand][1], tried[cand][2]
    return off, None, [], {}


async def build_history_qx(asset, tf, rec=None, broker="quotex"):
    """Provider candles (Quotex / IQ Option, already UTC) extended with our own recorded ticks; broker candles win."""
    t = now()
    main = []
    for window in (tf * ROWS, tf * 120, tf * 40):   # smaller windows if the broker refuses a big one
        try:
            main = await PROVIDERS[broker].candles(asset, tf, window)
            if main:
                break
        except Exception:
            continue
    merged = {c["time"]: c for c in main}
    ticks = rec.candles() if rec else []
    since = main[-1]["time"] if main else int(t // tf * tf) - tf * ROWS
    for c in aggregate(ticks, tf, since, t):
        merged.setdefault(c["time"], c)
    dbg = {"official_count": len(main), "official_newest": main[-1]["time"] if main else None,
           "tick_count": len(ticks), "check_close": main[-1]["close"] if main and t - main[-1]["time"] <= tf * 3 else None}
    return [merged[k] for k in sorted(merged)], dbg


async def history_checked_b(broker, client, asset, tf, live_price, rec=None):
    if broker not in PROVIDERS:
        return await history_checked(client, asset, tf, live_price, rec)
    cs, dbg = await build_history_qx(asset, tf, rec, broker)
    return 0, disagreement(dbg, live_price) or 0.0, cs, dbg


async def build_history_b(broker, client, asset, tf, off, rec=None):
    if broker not in PROVIDERS:
        return await build_history(client, asset, tf, off, rec)
    return await build_history_qx(asset, tf, rec, broker)


class Book:
    """Everything a chart has been shown. Merging only adds or corrects candles and never drops any, so a late or
    stale history response cannot open a hole."""

    def __init__(self, tf):
        self.tf, self.by = tf, {}

    def absorb(self, candles, forming):
        """Merge history in. The forming candle is only widened (its live values stay). Returns True if a closed
        candle was added or changed."""
        changed = False
        for c in candles:
            t = c["time"]
            if t > forming:
                continue
            if t == forming:
                cur = self.by.get(t)
                if cur is None:
                    self.by[t] = dict(c)
                else:
                    cur["high"], cur["low"] = max(cur["high"], c["high"]), min(cur["low"], c["low"])
                continue
            new = dict(c)
            if self.by.get(t) != new:
                self.by[t] = new
                changed = True
        cut = forming - self.tf * (ROWS + 60)
        for t in [t for t in self.by if t < cut]:
            del self.by[t]
        return changed

    def snapshot(self):
        return [dict(self.by[t]) for t in sorted(self.by)]

    def missing(self, forming):
        return holes(self.by.keys(), self.tf, forming)


@asynccontextmanager
async def lifespan(_):
    warm = asyncio.create_task(keep_warm())
    yield
    warm.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def account_is_demo(b):
    """Which kind of account the broker connection is using right now."""
    if b == "quotex":
        return getattr(QX, "is_demo", True)
    if b == "iqoption":
        return PROVIDERS["iqoption"].is_demo
    if b == "deriv":
        return DERIV.is_demo
    return True


def is_synthetic(sym: str) -> bool:
    s = (sym or "").upper()
    return (
        s.startswith("R_") or s.startswith("1HZ") or
        s.startswith("BOOM") or s.startswith("CRASH") or
        s.startswith("JD") or s.startswith("STPRNG") or
        s.startswith("RB") or s.startswith("RDBEAR") or s.startswith("RDBULL") or
        s.startswith("STEP") or "VOLATILITY" in s
    )


@app.get("/api/status")
async def status(broker: str = "deriv"):
    P = DERIV
    if not P.ready:
        await P.connect()
    return {"broker": "deriv", "ready": P.ready, "error": P.error or P.auth_error, "balance": P.balance,
            "demo": P.is_demo, "currency": P.currency, "assets": len([a for a in P.assets if is_synthetic(a.get("symbol", ""))]), "configured": P.configured}


@app.get("/api/assets")
async def assets(broker: str = "deriv"):
    P = DERIV
    if not P.ready:
        await P.connect()
    try:
        await P.list_assets()
    except Exception:
        pass
    synthetics = [a for a in P.assets if is_synthetic(a.get("symbol", ""))]
    return [{"symbol": a["symbol"], "name": a["name"], "payout": 95 if not a.get("payout") else a["payout"], "active": a.get("active", True)}
            for a in synthetics]


@app.get("/api/deriv/synthetic-candles")
async def get_synthetic_candles(symbol: str = "1HZ100V", tf: int = 60, count: int = 60):
    await DERIV.connect()
    cs = await DERIV.candles(symbol, tf, tf * count)
    return {"symbol": symbol, "tf": tf, "candles": cs}



@app.post("/api/set-credentials")
async def set_credentials(data: dict):
    """Quotex / IQ Option login. Kept in memory only."""
    b = bk(str(data.get("broker", "quotex")))
    if b not in PROVIDERS:
        return {"status": "error", "msg": "This broker does not use email/password"}
    email, pw = str(data.get("email", "")).strip(), str(data.get("password", "")).strip()
    ssid = str(data.get("ssid", "")).strip()
    if b == "deriv":
        token = ssid or email
        if not token:
            return {"status": "error", "msg": "Enter Deriv API Token / PAT"}
        DERIV.set_credentials(email, pw, ssid)
    elif b == "iqoption":
        if not ssid and not (email and pw):
            return {"status": "error", "msg": "Enter email and password, or an IQ Option SSID"}
        IQ.set_credentials(email, pw, ssid)
    else:
        if not ssid and (not email or not pw):
            return {"status": "error", "msg": "Enter Quotex session token, or email and password"}
        QX.set_credentials(email, pw, ssid)
    for k, f in list(feeds.items()):
        if f.broker == b and f.task:
            f.task.cancel()
    asyncio.create_task(PROVIDERS[b].connect())
    return {"status": "ok", "msg": f"{b} login saved, connecting..."}


@app.post("/api/set-ssid")
async def set_ssid(data: dict):
    global SSID
    new = str(data.get("ssid", "")).strip()
    if not new:
        return {"status": "error", "msg": "Empty SSID"}
    SSID = new
    try:
        open(SESSION_FILE, "w").write(new)
    except Exception:
        pass
    S.update(ready=False, client=None, error="")
    for f in list(feeds.values()):
        if f.broker == "pocket" and f.task:   # leave the other brokers' feeds alone
            f.task.cancel()
    asyncio.create_task(connect())
    return {"status": "ok", "msg": "SSID updated, reconnecting..."}


@app.post("/api/account")
async def set_account(data: dict):
    """Switch the broker between its DEMO and REAL account. {broker, demo: true|false}"""
    global SSID
    b = bk(str(data.get("broker", "pocket")))
    demo = bool(data.get("demo"))
    try:
        if b == "pocket":
            if not SSID:
                return {"status": "error", "msg": "No Pocket Option SSID set"}
            import re
            flag = "1" if demo else "0"
            if not re.search(r'"isDemo"\s*:\s*[01]', SSID):
                return {"status": "error", "msg": "This SSID has no isDemo flag, paste a fresh SSID for the account you want"}
            new = re.sub(r'("isDemo"\s*:\s*)[01]', lambda m: m.group(1) + flag, SSID, count=1)
            if new != SSID:
                SSID = new
                try:
                    open(SESSION_FILE, "w").write(new)
                except Exception:
                    pass
                S.update(ready=False, client=None, error="")
                for f in list(feeds.values()):
                    if f.broker == "pocket" and f.task:
                        f.task.cancel()
                asyncio.create_task(connect())
        elif b == "quotex":
            await QX.connect()
            if not (QX.ready and QX.client):
                return {"status": "error", "msg": QX.error or "Quotex is not connected"}
            from pyquotex.utils.account_type import AccountType
            await QX.client.api.change_account(AccountType.DEMO if demo else AccountType.REAL)
            QX.is_demo = demo
            await asyncio.sleep(1.5)
            try:
                QX.balance = float(await QX.client.get_balance())
            except Exception:
                pass
        elif b == "iqoption":
            err = await PROVIDERS["iqoption"].set_account(demo)
            if err:
                return {"status": "error", "msg": err}
        elif b == "deriv":
            err = await DERIV.set_account(demo)
            if err:
                return {"status": "error", "msg": err}
        else:
            return {"status": "error", "msg": "Unknown broker"}
        return {"status": "ok", "demo": demo, "msg": "Switched to the " + ("demo" if demo else "real") + " account"}
    except Exception as e:
        return {"status": "error", "msg": str(e) or e.__class__.__name__}


MAX_STAKE = 100000
TRADE_MIN_S, TRADE_MAX_S = 3, 86400


@app.post("/api/trade")
async def trade(data: dict):
    """Manual order from the dashboard: side buy (up) or sell (down), stake, expiry in seconds."""
    broker = bk(str(data.get("broker", "pocket")))
    asset = str(data.get("asset", "")).strip()
    side = str(data.get("side", "")).lower()
    try:
        amount = float(data.get("amount"))
        seconds = int(data.get("seconds"))
    except (TypeError, ValueError):
        return {"status": "error", "msg": "Amount or expiry is not a number"}
    if not asset:
        return {"status": "error", "msg": "No market selected"}
    if side not in ("buy", "sell"):
        return {"status": "error", "msg": "Side must be buy or sell"}
    if not (0 < amount <= MAX_STAKE) or amount != amount:
        return {"status": "error", "msg": f"Amount must be between 0 and {MAX_STAKE}"}
    if not (TRADE_MIN_S <= seconds <= TRADE_MAX_S):
        return {"status": "error", "msg": "Expiry must be between 3 seconds and 24 hours"}
    try:
        if broker == "pocket":
            client = await connect()
            if not client:
                return {"status": "error", "msg": S["error"] or "Pocket Option is not connected"}
            fn = client.buy if side == "buy" else client.sell     # in this library buy = call/up, sell = put/down
            try:
                res = await fn(asset=asset, amount=amount, time=seconds, check_win=False)
            except TypeError:
                res = await fn(asset, amount, seconds)
            tid = res[0] if isinstance(res, (tuple, list)) and res else res
            return {"status": "ok", "id": str(tid), "msg": "Trade placed"}
        if broker == "quotex":
            await QX.connect()
            if not (QX.ready and QX.client):
                return {"status": "error", "msg": QX.error or "Quotex is not connected"}
            ok, info = await QX.client.buy(amount, asset, "call" if side == "buy" else "put", seconds)
            if not ok:
                return {"status": "error", "msg": f"Quotex rejected the trade: {info}"}
            tid = info.get("id") if isinstance(info, dict) else None
            return {"status": "ok", "id": str(tid) if tid else "", "msg": "Trade placed"}
        if broker == "deriv":
            r = await DERIV.trade(asset, side, amount, seconds)
            return {"status": "ok", "id": str(r["id"] or ""), "msg": "Trade placed", "payout": r["payout"]}
        if broker == "iqoption":
            IQ = PROVIDERS["iqoption"]
            if not IQ.ready:
                await IQ.connect()
            if not IQ.ready:
                return {"status": "error", "msg": IQ.error or "IQ Option is not connected"}
            r = await IQ.trade(asset, side, amount, seconds)
            return {"status": "ok", "id": r["id"], "msg": "Trade placed"}
        return {"status": "error", "msg": "Trading is not available for this broker"}
    except Exception as e:
        return {"status": "error", "msg": str(e) or e.__class__.__name__}


def parse_result(r):
    """Different broker libraries describe a finished trade differently; reduce them to win / loss / draw + profit."""
    res, profit = "", None
    if isinstance(r, dict):
        res = str(r.get("result") or r.get("status") or r.get("win") or "").lower()
        profit = r.get("profit")
    elif isinstance(r, (tuple, list)) and r:
        res = str(r[0]).lower()
        profit = r[1] if len(r) > 1 else None
    else:
        res = str(r).lower()
    try:
        profit = float(profit) if profit is not None else None
    except (TypeError, ValueError):
        profit = None
    if "win" in res or res == "won":
        out = "win"
    elif "los" in res or res == "lost":
        out = "loss"
    elif any(w in res for w in ("draw", "equal", "refund", "tie")):
        out = "draw"
    elif profit is not None:
        out = "win" if profit > 0 else "loss" if profit < 0 else "draw"
    else:
        out = ""
    return {"result": out, "profit": profit}


@app.get("/api/trade-result")
async def trade_result(broker: str = "pocket", id: str = "", seconds: int = 60):
    """Official outcome of a trade placed through /api/trade. Waits until the broker has settled it."""
    broker = bk(broker)
    if not id:
        return {"status": "error", "msg": "No trade id"}
    wait = max(10, min(int(seconds), TRADE_MAX_S)) + 45
    try:
        if broker == "pocket":
            client = await connect()
            if not client:
                return {"status": "error", "msg": S["error"] or "Pocket Option is not connected"}
            r = await asyncio.wait_for(client.check_win(id), wait)
        elif broker == "quotex":
            if not (QX.ready and QX.client):
                return {"status": "error", "msg": QX.error or "Quotex is not connected"}
            r = await asyncio.wait_for(QX.client.check_win(id), wait)
        elif broker == "deriv":
            r = await DERIV.trade_result(id, wait)
        elif broker == "iqoption":
            r = await PROVIDERS["iqoption"].trade_result(id, wait)
        else:
            return {"status": "error", "msg": "Trade results are not available for this broker"}
        out = parse_result(r)
        if not out["result"]:
            return {"status": "error", "msg": "The broker did not report a clear result"}
        return {"status": "ok", **out}
    except asyncio.TimeoutError:
        return {"status": "error", "msg": "The broker took too long to report the result"}
    except Exception as e:
        return {"status": "error", "msg": str(e) or e.__class__.__name__}


@app.post("/api/engines")
async def api_engines(body: dict):
    """Run the sweep / indicator / candlestick engines on candles sent by the caller (no broker needed)."""
    from engines.combine import evaluate
    cs = body.get("candles") or []
    tf = int(body.get("tf") or 60)
    try:
        cs = [{"time": int(c["time"]), "open": float(c["open"]), "high": float(c["high"]),
               "low": float(c["low"]), "close": float(c["close"])} for c in cs][-600:]
    except Exception:
        return {"status": "error", "msg": "bad candles"}
    res = await asyncio.get_running_loop().run_in_executor(None, lambda: evaluate(cs, tf, int(body.get("minInd") or 1), now=body.get("now")))
    return {**res, "state": res["status"], "status": "ok"}   # "state" is the engines' own text


@app.get("/api/diag")
async def diag(asset: str = "EURUSD_otc", tf: int = 60, broker: str = "pocket"):
    """What the dashboard will draw: clock offset, verification against live price, newest candles, holes."""
    broker = bk(broker)
    client = await connect_broker(broker)
    if not client:
        return {"error": PROVIDERS[broker].error if broker in PROVIDERS else S["error"]}
    feed, q = attach(asset, broker)
    try:
        first = await asyncio.wait_for(q.get(), 10)
        if first is None:
            return {"error": "live feed ended"}
        live = first[1]
        off, gap, cs, dbg = await history_checked_b(broker, client, asset, tf, live, feed.rec)
        forming = int(now() // tf * tf)
        have = {c["time"] for c in cs}
        fmt = lambda c: {**c, "utc": utc(c["time"])}
        return {"broker": broker, "lib": lib_version(), "asset": asset, "tf": tf,
                "now_utc": utc(now()),
                "measured_broker_offset_s": await measure_offset(client) if broker == "pocket" else 0, "used_offset_s": off,
                "live_price": live, "gap_to_live_pct": None if gap is None else round(gap, 4),
                "count": len(cs), "newest": [fmt(c) for c in cs[-6:]],
                "sources": {k: (utc(v) if k.endswith(("newest", "since")) and v else v) for k, v in dbg.items()},
                "forming_candle_present": forming in have,
                "missing_candles_before_now": [utc(t) for t in holes(have, tf, forming)] if cs else None}
    except Exception as e:
        return {"error": str(e)}
    finally:
        detach(feed, q)


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    broker = bk(sock.query_params.get("broker", "pocket"))
    asset = sock.query_params.get("asset", DEFAULT_ASSET)
    tf = int(sock.query_params.get("tf", "60"))
    send_lock = asyncio.Lock()

    async def send(m):
        async with send_lock:
            await sock.send_text(json.dumps(m))

    feed = q = None
    tasks = []
    try:
        client = await connect_broker(broker)
        if not client:
            err = PROVIDERS[broker].error if broker in PROVIDERS else S["error"]
            await send({"type": "error", "msg": err or "bridge not ready"})
            return
        feed, q = attach(asset, broker)
        rec = feed.rec
        if rec.last and now() - rec.last[0] < 5:
            first = rec.last   # the recorder is warm: no need to wait for a tick
        else:
            try:
                first = await asyncio.wait_for(q.get(), 12)  # a tick must exist before the broker clock can be measured
            except asyncio.TimeoutError:
                await send({"type": "error", "msg": "no live ticks for this pair (market closed?)"})
                return
            if first is None:
                await send({"type": "error", "msg": "live feed ended"})
                return

        off, gap, candles, _ = await history_checked_b(broker, client, asset, tf, first[1], rec)
        if candles and gap is not None and gap > MAX_GAP_PCT:
            await send({"type": "info", "msg": f"history differs from live price by {gap:.2f}% even after clock correction; broker history hidden"})
            candles = aggregate(rec.candles(), tf, 0)
        book = Book(tf)
        forming = max(int(now() // tf * tf), int(first[0] // tf * tf))
        book.absorb(candles, forming)
        st = {"off": off, "price": first[1], "top": max(book.by) if book.by else 0, "until": 0}

        async def send_history(resync=False):
            async with send_lock:  # snapshot is taken inside the lock so no tick can be sent out of order
                await sock.send_text(json.dumps({"type": "history", "resync": resync, "candles": book.snapshot()}))

        if book.by:
            await send_history(False)
        miss = book.missing(forming)
        await send({"type": "info", "msg": f"{broker}: clock offset {off}s, {len(book.by)} candles" +
                    (f", {len(miss)} missing, retrying" if miss else "")})

        async def resync(delays):
            """Re-fetch broker history. Only ever adds or corrects candles; retries while holes remain."""
            i = 0
            while True:
                d = delays[i] if i < len(delays) else 10   # after the listed delays, poll every 10 s
                i += 1
                await sleep(d)
                try:
                    cs, dbg = await build_history_b(broker, client, asset, tf, st["off"], rec)
                    g = disagreement(dbg, st["price"])
                    if cs and (g is None or g <= MAX_GAP_PCT):
                        if book.absorb(cs, st["top"]):
                            await send_history(True)
                        # candles built from our ticks are only an approximation (the broker's own candles can have
                        # a wider range), so keep polling until the broker has published the candle that just closed
                        official = dbg.get("official_newest")
                        settled = official is not None and official >= st["top"] - tf
                        if settled and not book.missing(st["top"]):
                            break
                except Exception:
                    pass
                if i >= len(delays) and now() > st["until"]:
                    break

        resync_task = None

        def kick(delays, hold=0):
            """Start a history refresh; hold keeps polling alive for that many seconds even if a refresh is running."""
            nonlocal resync_task
            st["until"] = max(st["until"], now() + hold)
            if not (resync_task and not resync_task.done()):
                resync_task = asyncio.create_task(resync(delays))
                tasks.append(resync_task)

        if miss:
            kick((2, 6, 15, 30, 60), hold=180)
        synced = now()

        async def pump():
            nonlocal synced
            pending = [first]
            while True:
                if pending:
                    tick = pending.pop(0)
                else:
                    try:
                        tick = await asyncio.wait_for(q.get(), 20)
                    except asyncio.TimeoutError:
                        await send({"type": "info", "msg": "no ticks for 20s (market closed or feed paused)"})
                        continue
                if tick is None:
                    await send({"type": "error", "msg": "live feed ended, reconnecting"})
                    return
                ts, price = tick
                b = int(ts // tf * tf)
                if b < st["top"]:
                    continue  # late tick for a candle that is already closed
                st["price"] = price
                cur = book.by.get(b)
                if cur:
                    cur["high"], cur["low"], cur["close"] = max(cur["high"], price), min(cur["low"], price), price
                else:
                    prev = book.by.get(b - tf)  # broker candles chain: a new candle opens at the previous close
                    o = prev["close"] if prev else price
                    cur = book.by[b] = {"time": b, "open": o, "high": max(o, price), "low": min(o, price), "close": price}
                rolled = b > st["top"]
                st["top"] = b
                await send({"type": "tick", "price": price, "ts": ts, "candle": cur})
                if rolled and tf >= 30:
                    kick((3, 5), hold=360)
                elif tf < 30 and now() - synced > 60:
                    synced = now()
                    kick((0,))

        async def watch():
            while True:
                m = await sock.receive()
                if m.get("type") == "websocket.disconnect":
                    return

        tasks.extend([asyncio.create_task(pump()), asyncio.create_task(watch())])
        await asyncio.wait(tasks[-2:], return_when=asyncio.FIRST_COMPLETED)
    except Exception as e:
        try:
            await send({"type": "error", "msg": str(e)})
        except Exception:
            pass
    finally:
        for t in tasks:
            t.cancel()
        if feed and q:
            detach(feed, q)
