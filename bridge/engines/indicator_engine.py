"""
Indicator combination engine (trend indicator + momentum oscillator), incremental / live-ready.

Strategies (each votes BUY or SELL on a closed candle):
  S1  EMA50 + MACD(12,26,9)       call: close > EMA50 and MACD crosses above signal while MACD < 0 ; put mirrored
  S2  EMA7/26 cross + RSI14 + MACD  call: EMA7 crosses above EMA26, RSI > 50 and MACD histogram rising ; put mirrored
  S3  Williams %R(7) + Stochastic(7,4,3 EMA)  exhaustion reversal at local support/resistance with a confirming candle
  S4  Bollinger(20,2) + RSI mean-reversion  (added) range-market counterpart to the trend strategies
  S5  Vortex(14) + TSI(25,13)    trend/momentum: VI+/VI- cross and TSI/signal cross within a few bars of each other
  S6  RSI(14, 85/15) + Center of Gravity   reversal: RSI extreme, then price closes back inside the regression-channel band
                                  (Center of Gravity here = linear-regression line with +/- k*stdev bands; the source gave no formula)
  S7  Keltner(20, 2*ATR) reversal  close back inside the channel after closing outside it, with a confirming candle

Filters (the "key rules"):
  * ADX regime: trend strategies (S1,S2) need ADX >= adx_min (skip chop);
                reversal strategies (S3,S4) are blocked when ADX is strong AND the trend runs against the trade;
                S4 only works in a range (ADX <= adx_range).
  * warmup so every indicator has settled.
  * several strategies voting the same way is a stronger signal (min_votes); conflicting votes = no trade.

Usage (batch):  python indicator_engine.py candles.csv [--min-votes 2] [--no-sr]
Usage (live) :  eng = Engine(); sig = eng.update(Candle(t,o,h,l,c))
"""
from __future__ import annotations
import csv, sys
from collections import deque
from dataclasses import dataclass, field


@dataclass
class Candle:
    t: str
    o: float
    h: float
    l: float
    c: float


@dataclass
class Params:
    ema_trend: int = 50
    ema_fast: int = 7
    ema_slow: int = 26
    macd: tuple = (12, 26, 9)
    rsi_n: int = 14
    wr_n: int = 7
    stoch: tuple = (7, 4, 3)       # K period, D period, smoothing (all EMA)
    bb_n: int = 20
    bb_k: float = 2.0
    adx_n: int = 14
    adx_min: float = 18.0          # trend strategies need at least this much trend
    adx_strong: float = 30.0       # above this, oscillator reversals against the trend are blocked
    adx_range: float = 22.0        # S4 only below this
    cross_window: int = 3          # S2: bars allowed between the EMA cross and RSI/MACD alignment
    osc_window: int = 3            # S3: bars allowed between the %R event and the Stochastic cross
    wr_os: float = -80.0
    wr_ob: float = -20.0
    st_os: float = 25.0
    st_ob: float = 75.0
    use_sr: bool = True            # S3: require a local support/resistance + confirming candle
    sr_lb: int = 30
    sr_tol_atr: float = 0.5
    vortex_n: int = 14
    tsi: tuple = (25, 13, 7)       # long EMA, short EMA, signal EMA
    cog_n: int = 20
    cog_k: float = 2.0
    rsi_x_os: float = 15.0         # S6 RSI extremes (per the source's 15/85)
    rsi_x_ob: float = 85.0
    kc_n: int = 20
    kc_mult: float = 2.0
    enabled: tuple = ("S1", "S2", "S3", "S4", "S5", "S6", "S7")
    min_votes: int = 1
    warmup: int = 120


# ------------------------------------------------------------------ incremental indicators
class EMA:
    def __init__(s, n): s.a = 2 / (n + 1); s.v = None
    def u(s, x):
        s.v = x if s.v is None else s.v + s.a * (x - s.v)
        return s.v


class RSI:
    def __init__(s, n): s.n = n; s.prev = None; s.ag = s.al = 0.0; s.k = 0; s.v = None
    def u(s, c):
        if s.prev is None:
            s.prev = c; return None
        d = c - s.prev; s.prev = c
        g, l = max(d, 0.0), max(-d, 0.0); s.k += 1
        if s.k < s.n:
            s.ag += g; s.al += l; return None
        if s.k == s.n:
            s.ag = (s.ag + g) / s.n; s.al = (s.al + l) / s.n
        else:
            s.ag = (s.ag * (s.n - 1) + g) / s.n; s.al = (s.al * (s.n - 1) + l) / s.n
        s.v = 100.0 if s.al == 0 else 100 - 100 / (1 + s.ag / s.al)
        return s.v


class ADX:
    """Wilder ADX with +DI / -DI and ATR."""
    def __init__(s, n):
        s.n = n; s.pc = None; s.k = 0; s.tr = s.pdm = s.mdm = 0.0
        s.dxk = 0; s.dxs = 0.0; s.adx = None
    def u(s, c):
        if s.pc is None:
            s.pc = c; return None, None, None, None
        p = s.pc; s.pc = c; n = s.n
        tr = max(c.h - c.l, abs(c.h - p.c), abs(c.l - p.c))
        up, dn = c.h - p.h, p.l - c.l
        pdm = up if up > dn and up > 0 else 0.0
        mdm = dn if dn > up and dn > 0 else 0.0
        s.k += 1
        if s.k <= n:
            s.tr += tr; s.pdm += pdm; s.mdm += mdm
            if s.k < n: return None, None, None, None
        else:
            s.tr += tr - s.tr / n; s.pdm += pdm - s.pdm / n; s.mdm += mdm - s.mdm / n
        pdi = 100 * s.pdm / s.tr if s.tr else 0.0
        mdi = 100 * s.mdm / s.tr if s.tr else 0.0
        dx = 100 * abs(pdi - mdi) / (pdi + mdi) if pdi + mdi else 0.0
        s.dxk += 1
        if s.dxk <= n:
            s.dxs += dx
            if s.dxk == n: s.adx = s.dxs / n
        else:
            s.adx = (s.adx * (n - 1) + dx) / n
        return s.adx, pdi, mdi, s.tr / n


class Indicators:
    def __init__(s, P: Params):
        s.P = P
        s.et, s.ef, s.es = EMA(P.ema_trend), EMA(P.ema_fast), EMA(P.ema_slow)
        s.m1, s.m2, s.msig = EMA(P.macd[0]), EMA(P.macd[1]), EMA(P.macd[2])
        s.rsi = RSI(P.rsi_n); s.adx = ADX(P.adx_n)
        s.hw = deque(maxlen=P.wr_n); s.lw = deque(maxlen=P.wr_n)
        s.hk = deque(maxlen=P.stoch[0]); s.lk = deque(maxlen=P.stoch[0])
        s.ks, s.kd = EMA(P.stoch[2]), EMA(P.stoch[1])
        s.bb = deque(maxlen=P.bb_n)
        s.pc = None; s.vmp = deque(maxlen=P.vortex_n); s.vmm = deque(maxlen=P.vortex_n); s.vtr = deque(maxlen=P.vortex_n)
        s.t1, s.t2, s.a1, s.a2, s.ts = EMA(P.tsi[0]), EMA(P.tsi[1]), EMA(P.tsi[0]), EMA(P.tsi[1]), EMA(P.tsi[2])
        s.cg = deque(maxlen=P.cog_n); s.kc = EMA(P.kc_n)
    def u(s, c: Candle) -> dict:
        P = s.P; v = {"c": c.c}
        v["ema_t"], v["ema_f"], v["ema_s"] = s.et.u(c.c), s.ef.u(c.c), s.es.u(c.c)
        v["macd"] = s.m1.u(c.c) - s.m2.u(c.c)
        v["sig"] = s.msig.u(v["macd"]); v["hist"] = v["macd"] - v["sig"]
        v["rsi"] = s.rsi.u(c.c)
        v["adx"], v["pdi"], v["mdi"], v["atr"] = s.adx.u(c)
        s.hw.append(c.h); s.lw.append(c.l)
        hh, ll = max(s.hw), min(s.lw)
        v["wr"] = -100 * (hh - c.c) / (hh - ll) if len(s.hw) == P.wr_n and hh > ll else None
        s.hk.append(c.h); s.lk.append(c.l)
        hh, ll = max(s.hk), min(s.lk)
        if len(s.hk) == P.stoch[0] and hh > ll:
            raw = 100 * (c.c - ll) / (hh - ll); v["k"] = s.ks.u(raw); v["d"] = s.kd.u(v["k"])
        else:
            v["k"] = v["d"] = None
        s.bb.append(c.c)
        if len(s.bb) == P.bb_n:
            m = sum(s.bb) / P.bb_n; sd = (sum((x - m) ** 2 for x in s.bb) / P.bb_n) ** 0.5
            v["bb_lo"], v["bb_up"], v["bb_mid"] = m - P.bb_k * sd, m + P.bb_k * sd, m
        else:
            v["bb_lo"] = v["bb_up"] = v["bb_mid"] = None
        # Vortex + TSI
        v["vip"] = v["vim"] = v["tsi"] = v["tsig"] = None
        if s.pc is not None:
            pc = s.pc
            s.vmp.append(abs(c.h - pc.l)); s.vmm.append(abs(c.l - pc.h))
            s.vtr.append(max(c.h - c.l, abs(c.h - pc.c), abs(c.l - pc.c)))
            if len(s.vtr) == P.vortex_n and sum(s.vtr) > 0:
                st = sum(s.vtr); v["vip"], v["vim"] = sum(s.vmp) / st, sum(s.vmm) / st
            m = c.c - pc.c
            num = s.t2.u(s.t1.u(m)); den = s.a2.u(s.a1.u(abs(m)))
            v["tsi"] = 100 * num / den if den else 0.0
            v["tsig"] = s.ts.u(v["tsi"])
        s.pc = c
        # Center of Gravity (linear regression line +/- k*stdev of residuals)
        s.cg.append(c.c); v["cog_lo"] = v["cog_up"] = None
        if len(s.cg) == P.cog_n:
            n = P.cog_n; xm = (n - 1) / 2; ys = list(s.cg); yb = sum(ys) / n
            sxx = sum((i - xm) ** 2 for i in range(n)); b = sum((i - xm) * (y - yb) for i, y in enumerate(ys)) / sxx
            a = yb - b * xm
            sd = (sum((y - (a + b * i)) ** 2 for i, y in enumerate(ys)) / n) ** 0.5
            fit = a + b * (n - 1); v["cog_lo"], v["cog_up"] = fit - P.cog_k * sd, fit + P.cog_k * sd
        # Keltner
        mid = s.kc.u(c.c); v["kc_lo"] = v["kc_up"] = None
        if v["atr"] is not None:
            v["kc_lo"], v["kc_up"] = mid - P.kc_mult * v["atr"], mid + P.kc_mult * v["atr"]
        return v


@dataclass
class Signal:
    index: int
    side: str
    strategies: list
    entry: float
    info: dict = field(default_factory=dict)


class Engine:
    def __init__(self, params: Params | None = None):
        self.P = params or Params()
        self.ind = Indicators(self.P)
        self.n = -1
        self.prev = None
        self.lows = deque(maxlen=self.P.sr_lb); self.highs = deque(maxlen=self.P.sr_lb)
        self.cross = None          # (side, bar) of the last EMA fast/slow cross, armed for S2
        self.wr_ev = {"BUY": -99, "SELL": -99}
        self.st_ev = {"BUY": -99, "SELL": -99}
        self.vx_ev = {"BUY": -99, "SELL": -99}
        self.tsi_ev = {"BUY": -99, "SELL": -99}
        self.rsi_x = {"BUY": -99, "SELL": -99}

    def update(self, c: Candle):
        P = self.P
        self.n += 1; n = self.n
        v = self.ind.u(c); p = self.prev
        valid = all(v[k] is not None for k in ("rsi", "adx", "wr", "k", "d", "bb_lo", "atr", "vip", "tsi", "cog_lo", "kc_lo"))
        sr_lo = min(self.lows) if self.lows else None
        sr_hi = max(self.highs) if self.highs else None
        self.lows.append(c.l); self.highs.append(c.h)
        self.prev = v
        if p is None or not all(p[k] is not None for k in ("rsi", "wr", "k", "d", "bb_lo", "vip", "tsi", "cog_lo", "kc_lo")) or not valid:
            return None
        # ---- events
        if p["ema_f"] <= p["ema_s"] and v["ema_f"] > v["ema_s"]: self.cross = ("BUY", n)
        if p["ema_f"] >= p["ema_s"] and v["ema_f"] < v["ema_s"]: self.cross = ("SELL", n)
        if p["wr"] <= P.wr_os < v["wr"]: self.wr_ev["BUY"] = n
        if p["wr"] >= P.wr_ob > v["wr"]: self.wr_ev["SELL"] = n
        if p["k"] <= p["d"] and v["k"] > v["d"] and min(p["k"], p["d"]) <= P.st_os: self.st_ev["BUY"] = n
        if p["k"] >= p["d"] and v["k"] < v["d"] and max(p["k"], p["d"]) >= P.st_ob: self.st_ev["SELL"] = n
        if p["vip"] <= p["vim"] and v["vip"] > v["vim"]: self.vx_ev["BUY"] = n
        if p["vip"] >= p["vim"] and v["vip"] < v["vim"]: self.vx_ev["SELL"] = n
        if p["tsi"] <= p["tsig"] and v["tsi"] > v["tsig"]: self.tsi_ev["BUY"] = n
        if p["tsi"] >= p["tsig"] and v["tsi"] < v["tsig"]: self.tsi_ev["SELL"] = n
        if v["rsi"] <= P.rsi_x_os: self.rsi_x["BUY"] = n
        if v["rsi"] >= P.rsi_x_ob: self.rsi_x["SELL"] = n
        if n < P.warmup:
            return None
        adx, up_trend, dn_trend = v["adx"], v["pdi"] > v["mdi"], v["mdi"] > v["pdi"]
        trending = adx >= P.adx_min
        votes = {"BUY": [], "SELL": []}

        if "S1" in P.enabled and trending:
            if v["c"] > v["ema_t"] and p["macd"] <= p["sig"] and v["macd"] > v["sig"] and v["macd"] < 0:
                votes["BUY"].append("S1")
            if v["c"] < v["ema_t"] and p["macd"] >= p["sig"] and v["macd"] < v["sig"] and v["macd"] > 0:
                votes["SELL"].append("S1")

        if "S2" in P.enabled and trending and self.cross and n - self.cross[1] <= P.cross_window:
            side = self.cross[0]
            if side == "BUY" and v["ema_f"] > v["ema_s"] and v["rsi"] > 50 and v["hist"] > p["hist"]:
                votes["BUY"].append("S2"); self.cross = None
            elif side == "SELL" and v["ema_f"] < v["ema_s"] and v["rsi"] < 50 and v["hist"] < p["hist"]:
                votes["SELL"].append("S2"); self.cross = None

        if "S3" in P.enabled:
            tol = P.sr_tol_atr * v["atr"]
            if max(self.wr_ev["BUY"], self.st_ev["BUY"]) == n and n - min(self.wr_ev["BUY"], self.st_ev["BUY"]) <= P.osc_window:
                ok = not (adx >= P.adx_strong and dn_trend)                      # no buying a strong downtrend
                if P.use_sr: ok = ok and sr_lo is not None and c.l <= sr_lo + tol and c.c > c.o
                if ok: votes["BUY"].append("S3")
            if max(self.wr_ev["SELL"], self.st_ev["SELL"]) == n and n - min(self.wr_ev["SELL"], self.st_ev["SELL"]) <= P.osc_window:
                ok = not (adx >= P.adx_strong and up_trend)
                if P.use_sr: ok = ok and sr_hi is not None and c.h >= sr_hi - tol and c.c < c.o
                if ok: votes["SELL"].append("S3")

        if "S4" in P.enabled and adx <= P.adx_range:
            if p["c"] < p["bb_lo"] and v["c"] > v["bb_lo"] and v["rsi"] < 40: votes["BUY"].append("S4")
            if p["c"] > p["bb_up"] and v["c"] < v["bb_up"] and v["rsi"] > 60: votes["SELL"].append("S4")

        if "S5" in P.enabled and trending:
            for sd_ in ("BUY", "SELL"):
                a_, b_ = self.vx_ev[sd_], self.tsi_ev[sd_]
                if max(a_, b_) == n and n - min(a_, b_) <= P.osc_window:
                    votes[sd_].append("S5")

        if "S6" in P.enabled:
            if n - self.rsi_x["BUY"] <= 1 and p["c"] <= p["cog_lo"] and v["c"] > v["cog_lo"] and not (adx >= P.adx_strong and dn_trend):
                votes["BUY"].append("S6")
            if n - self.rsi_x["SELL"] <= 1 and p["c"] >= p["cog_up"] and v["c"] < v["cog_up"] and not (adx >= P.adx_strong and up_trend):
                votes["SELL"].append("S6")

        if "S7" in P.enabled:
            if p["c"] < p["kc_lo"] and v["c"] > v["kc_lo"] and c.c > c.o and not (adx >= P.adx_strong and dn_trend):
                votes["BUY"].append("S7")
            if p["c"] > p["kc_up"] and v["c"] < v["kc_up"] and c.c < c.o and not (adx >= P.adx_strong and up_trend):
                votes["SELL"].append("S7")

        nb, ns = len(votes["BUY"]), len(votes["SELL"])
        if nb == ns or max(nb, ns) < P.min_votes:
            return None
        side = "BUY" if nb > ns else "SELL"
        info = {k: round(v[k], 5) for k in ("rsi", "adx", "macd", "hist", "wr", "k", "d")}
        return Signal(n, side, votes[side], c.c, info)


def run(cs, params=None):
    e = Engine(params)
    return [s for c in cs if (s := e.update(c))]


def binary_backtest(cs, sigs, expiries=(1, 2, 3, 4, 5), payout=0.92, show=True):
    out = {}
    for n in expiries:
        w = l = 0; per: dict = {}
        for s in sigs:
            j = s.index + n
            if j >= len(cs): continue
            d = cs[j].c - s.entry
            win = d > 0 if s.side == "BUY" else d < 0
            loss = d < 0 if s.side == "BUY" else d > 0
            if not (win or loss): continue
            w += win; l += loss
            for k in s.strategies:
                a = per.setdefault(k, [0, 0]); a[0] += win; a[1] += loss
        t = w + l; wr = w / t if t else 0
        out[n] = (t, wr, per)
        if show:
            print(f"expiry {n}: trades={t:5d} winrate={wr:6.1%} EV/unit={wr*payout-(1-wr):+.3f}")
    return out


def load_csv(path):
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            r = {k.lower(): v for k, v in r.items()}
            out.append(Candle(r.get("time") or r.get("epoch") or r.get("date") or "",
                              float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python indicator_engine.py candles.csv [--min-votes N] [--no-sr]"); sys.exit(0)
    P = Params(use_sr="--no-sr" not in sys.argv)
    if "--min-votes" in sys.argv: P.min_votes = int(sys.argv[sys.argv.index("--min-votes") + 1])
    cs = load_csv(sys.argv[1]); sigs = run(cs, P)
    print(f"{len(cs)} candles, {len(sigs)} signals ({sum(s.side=='BUY' for s in sigs)} buy / {sum(s.side=='SELL' for s in sigs)} sell)\n")
    res = binary_backtest(cs, sigs)
    print("\nPer strategy, expiry 3:")
    for k, (w, l) in sorted(res[3][2].items()):
        print(f"  {k}: trades={w+l:4d} winrate={w/max(1,w+l):6.1%}")
