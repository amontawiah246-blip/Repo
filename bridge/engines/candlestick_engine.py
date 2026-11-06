"""
Candlestick pattern engine: all 54 patterns from the field guide.

Follows the guide's process:
  1. context first  : reversal patterns need a prior trend (BUY after a decline, SELL after an advance),
                      continuation patterns need an established trend in their direction;
  2. closed candles : patterns are only read on closed candles;
  3. confirmation   : patterns the guide calls "warnings" (harami, hammer, doji...) wait for a close
                      beyond the pattern boundary within `confirm_window` candles, and are dropped if the
                      opposite boundary breaks first. Patterns whose last candle is the confirmation fire at once;
  4. invalidation   : every signal carries a structural stop (beyond the pattern low/high).

Usage (batch):  python candlestick_engine.py candles.csv     (cols: time,open,high,low,close)
Usage (live)  : eng = Engine(); sig = eng.update(Candle(t,o,h,l,c))   # returns Signal or None
"""
from __future__ import annotations
import csv, sys
from dataclasses import dataclass, field


@dataclass
class Candle:
    t: str
    o: float
    h: float
    l: float
    c: float
    @property
    def top(self): return max(self.o, self.c)
    @property
    def bot(self): return min(self.o, self.c)
    @property
    def body(self): return abs(self.c - self.o)
    @property
    def rng(self): return max(self.h - self.l, 1e-12)
    @property
    def uw(self): return self.h - self.top
    @property
    def lw(self): return self.bot - self.l
    @property
    def mid(self): return (self.o + self.c) / 2
    @property
    def bull(self): return self.c > self.o
    @property
    def bear(self): return self.c < self.o


@dataclass
class Params:
    atr_n: int = 14
    trend_lb: int = 8            # candles used to judge the prior trend
    trend_atr: float = 1.2       # net move needed (in ATRs) to call a trend
    trend_agree: float = 0.55    # share of closes that must move the same way
    doji: float = 0.10           # body/range at or below this = doji
    long_body: float = 0.6       # body/range for a "long" candle ...
    long_atr: float = 0.8        # ... which must also be >= this * ATR
    tol_atr: float = 0.10        # "equal" levels (tweezers, matching low) tolerance in ATRs
    gap_mode: str = "body"       # "body" or "range"; true gaps are rare in continuous FX / synthetic data
    confirm_window: int = 2      # candles allowed for a confirmation close
    confirm_all: bool = False    # force a follow-through close on EVERY pattern
    require_level: bool = False  # reversals must sit at a recent swing low/high (the guide's "location")
    level_lb: int = 30
    level_tol_atr: float = 1.0
    exhaust_atr: float = 6.0     # skip soldiers/crows after an already extended run
    trade_neutral: bool = True   # trade doji/spinning top/inside/outside bar on a confirmed break
    min_score: int = 1           # min number of agreeing patterns


def long_(x, A, P): return x.body >= P.long_body * x.rng and x.body >= P.long_atr * A
def is_doji(x, P): return x.body <= P.doji * x.rng
def gap_up(a, b, P): return b.l > a.h if P.gap_mode == "range" else b.bot > a.top
def gap_dn(a, b, P): return b.h < a.l if P.gap_mode == "range" else b.top < a.bot


# ---------------------------------------------------------------- pattern shapes
# each fn(c, A, P) gets the candles of the pattern (oldest first) and the ATR.
def hammer(c, A, P):
    x = c[0]; return P.doji * x.rng < x.body <= 0.35 * x.rng and x.lw >= max(2 * x.body, 0.55 * x.rng) and x.uw <= 0.15 * x.rng
def inv_hammer(c, A, P):
    x = c[0]; return P.doji * x.rng < x.body <= 0.35 * x.rng and x.uw >= max(2 * x.body, 0.55 * x.rng) and x.lw <= 0.15 * x.rng
def dragonfly(c, A, P):
    x = c[0]; return is_doji(x, P) and x.lw >= 0.6 * x.rng and x.uw <= 0.1 * x.rng
def gravestone(c, A, P):
    x = c[0]; return is_doji(x, P) and x.uw >= 0.6 * x.rng and x.lw <= 0.1 * x.rng
def long_legged(c, A, P):
    x = c[0]; return is_doji(x, P) and x.uw >= 0.35 * x.rng and x.lw >= 0.35 * x.rng
def std_doji(c, A, P):
    x = c[0]; return is_doji(x, P) and not (dragonfly(c, A, P) or gravestone(c, A, P) or long_legged(c, A, P))
def spinning(c, A, P):
    x = c[0]; return P.doji * x.rng < x.body <= 0.3 * x.rng and x.uw >= 0.25 * x.rng and x.lw >= 0.25 * x.rng
def bull_maru(c, A, P):
    x = c[0]; return x.bull and x.body >= 0.9 * x.rng and x.body >= P.long_atr * A
def bear_maru(c, A, P):
    x = c[0]; return x.bear and x.body >= 0.9 * x.rng and x.body >= P.long_atr * A
def bull_belt(c, A, P):
    x = c[0]; return x.bull and long_(x, A, P) and x.lw <= 0.1 * x.rng
def bear_belt(c, A, P):
    x = c[0]; return x.bear and long_(x, A, P) and x.uw <= 0.1 * x.rng

def bull_eng(c, A, P):
    a, b = c; return a.bear and b.bull and b.o <= a.c and b.c >= a.o and b.body > a.body and b.body >= 0.5 * A
def bear_eng(c, A, P):
    a, b = c; return a.bull and b.bear and b.o >= a.c and b.c <= a.o and b.body > a.body and b.body >= 0.5 * A
def bull_harami(c, A, P):
    a, b = c; return a.bear and long_(a, A, P) and b.bull and not is_doji(b, P) and b.o >= a.c and b.c <= a.o and b.body <= 0.6 * a.body
def bear_harami(c, A, P):
    a, b = c; return a.bull and long_(a, A, P) and b.bear and not is_doji(b, P) and b.o <= a.c and b.c >= a.o and b.body <= 0.6 * a.body
def bull_harami_x(c, A, P):
    a, b = c; return a.bear and long_(a, A, P) and is_doji(b, P) and b.top <= a.o and b.bot >= a.c
def bear_harami_x(c, A, P):
    a, b = c; return a.bull and long_(a, A, P) and is_doji(b, P) and b.top <= a.c and b.bot >= a.o
def piercing(c, A, P):
    a, b = c; return a.bear and long_(a, A, P) and b.bull and b.o <= a.c and a.mid < b.c < a.o
def dark_cloud(c, A, P):
    a, b = c; return a.bull and long_(a, A, P) and b.bear and b.o >= a.c and a.o < b.c < a.mid
def tweezer_bot(c, A, P):
    a, b = c; return a.bear and b.bull and abs(a.l - b.l) <= P.tol_atr * A
def tweezer_top(c, A, P):
    a, b = c; return a.bull and b.bear and abs(a.h - b.h) <= P.tol_atr * A
def bull_kicker(c, A, P):
    a, b = c; return a.bear and b.bull and gap_up(a, b, P) and long_(b, A, P)
def bear_kicker(c, A, P):
    a, b = c; return a.bull and b.bear and gap_dn(a, b, P) and long_(b, A, P)
def matching_low(c, A, P):
    a, b = c; return a.bear and b.bear and a.body >= 0.5 * A and abs(a.c - b.c) <= P.tol_atr * A
def stick_sandwich(c, A, P):
    a, b, d = c; return a.bear and b.bull and d.bear and b.body >= 0.3 * A and abs(a.c - d.c) <= P.tol_atr * A
def bull_sep(c, A, P):
    a, b = c; return a.bear and b.bull and long_(b, A, P) and abs(a.o - b.o) <= P.tol_atr * A
def bear_sep(c, A, P):
    a, b = c; return a.bull and b.bear and long_(b, A, P) and abs(a.o - b.o) <= P.tol_atr * A

def morning_star(c, A, P):
    a, b, d = c; tol = P.tol_atr * A
    return a.bear and long_(a, A, P) and not is_doji(b, P) and b.body <= 0.4 * a.body and b.bot <= a.c + tol and d.bull and d.c > a.mid and d.body >= 0.5 * A
def evening_star(c, A, P):
    a, b, d = c; tol = P.tol_atr * A
    return a.bull and long_(a, A, P) and not is_doji(b, P) and b.body <= 0.4 * a.body and b.top >= a.c - tol and d.bear and d.c < a.mid and d.body >= 0.5 * A
def morning_doji(c, A, P):
    a, b, d = c; return a.bear and long_(a, A, P) and is_doji(b, P) and b.bot <= a.c + P.tol_atr * A and d.bull and d.c > a.mid and d.body >= 0.5 * A
def evening_doji(c, A, P):
    a, b, d = c; return a.bull and long_(a, A, P) and is_doji(b, P) and b.top >= a.c - P.tol_atr * A and d.bear and d.c < a.mid and d.body >= 0.5 * A
def soldiers(c, A, P):
    tol = P.tol_atr * A
    if not all(x.bull and x.body >= 0.5 * x.rng and x.body >= 0.5 * A and x.uw <= 0.3 * x.rng for x in c): return False
    return all(c[k].c > c[k-1].c and c[k-1].o <= c[k].o <= c[k-1].c + tol for k in (1, 2))
def crows(c, A, P):
    tol = P.tol_atr * A
    if not all(x.bear and x.body >= 0.5 * x.rng and x.body >= 0.5 * A and x.lw <= 0.3 * x.rng for x in c): return False
    return all(c[k].c < c[k-1].c and c[k-1].c - tol <= c[k].o <= c[k-1].o for k in (1, 2))
def inside_up(c, A, P):
    a, b, d = c; return bull_harami([a, b], A, P) and d.bull and d.c > a.o
def inside_dn(c, A, P):
    a, b, d = c; return bear_harami([a, b], A, P) and d.bear and d.c < a.o
def outside_up(c, A, P):
    a, b, d = c; return bull_eng([a, b], A, P) and d.bull and d.c > b.c
def outside_dn(c, A, P):
    a, b, d = c; return bear_eng([a, b], A, P) and d.bear and d.c < b.c
def baby_bull(c, A, P):
    a, b, d = c; return a.bear and long_(a, A, P) and is_doji(b, P) and gap_dn(a, b, P) and d.bull and gap_up(b, d, P)
def baby_bear(c, A, P):
    a, b, d = c; return a.bull and long_(a, A, P) and is_doji(b, P) and gap_up(a, b, P) and d.bear and gap_dn(b, d, P)
def gap_two_crows(c, A, P):
    a, b, d = c; return a.bull and long_(a, A, P) and b.bear and b.body <= 0.6 * a.body and gap_up(a, b, P) and d.bear and d.o > b.o and b.c > d.c > a.c
def tasuki_up(c, A, P):
    a, b, d = c; return a.bull and b.bull and gap_up(a, b, P) and d.bear and b.bot <= d.o <= b.top and a.top < d.c < b.bot
def tasuki_dn(c, A, P):
    a, b, d = c; return a.bear and b.bear and gap_dn(a, b, P) and d.bull and b.bot <= d.o <= b.top and b.top < d.c < a.bot
def advance_block(c, A, P):
    a, b, d = c
    if not (a.bull and b.bull and d.bull and a.c < b.c < d.c): return False
    shrink = b.body <= a.body and d.body < b.body
    wicks = d.uw > b.uw > a.uw and d.uw >= 0.25 * d.rng
    return shrink or wicks
def deliberation(c, A, P):
    a, b, d = c
    return a.bull and b.bull and d.bull and a.c < b.c < d.c and a.body >= 0.6 * a.rng and b.body >= 0.6 * b.rng and d.body <= 0.5 * b.body and d.o >= b.c - 0.3 * b.body
def three_stars(c, A, P):
    a, b, d = c
    return all(x.bear for x in c) and a.body > b.body > d.body and a.rng > b.rng > d.rng and b.l >= a.l and d.l >= b.l and d.h <= b.h and d.body >= 0.7 * d.rng

def _methods(c, A, P, up):
    a, *mid, e = c
    if up:
        ok = a.bull and long_(a, A, P) and e.bull and e.c > a.c and e.body >= 0.5 * a.body
    else:
        ok = a.bear and long_(a, A, P) and e.bear and e.c < a.c and e.body >= 0.5 * a.body
    return ok and all(m.body <= 0.5 * a.body and m.h <= a.h and m.l >= a.l for m in mid)
def rising3(c, A, P): return _methods(c, A, P, True)
def falling3(c, A, P): return _methods(c, A, P, False)
def mat_hold_bull(c, A, P):
    a, *mid, e = c; return _methods(c, A, P, True) and all(m.l >= a.mid for m in mid) and e.c > max(m.h for m in mid)
def mat_hold_bear(c, A, P):
    a, *mid, e = c; return _methods(c, A, P, False) and all(m.h <= a.mid for m in mid) and e.c < min(m.l for m in mid)
def ladder_bottom(c, A, P):
    a, b, d, e, f = c
    return (all(x.bear for x in (a, b, d, e)) and a.c > b.c > d.c and b.o <= a.o and d.o <= b.o and e.uw >= 0.3 * e.rng
            and f.bull and f.o >= e.bot and f.c > e.h)
def inside_bar(c, A, P):
    a, b = c; return b.h <= a.h and b.l >= a.l and a.rng >= 0.8 * A
def outside_bar(c, A, P):
    a, b = c; return b.h > a.h and b.l < a.l and b.rng >= A


# name, side, kind, span, trend needed (+1 up / -1 down / 0 any), confirmation ("self"/"next"), fn, late-check
PATTERNS = [
    ("Hammer", "BUY", "reversal", 1, -1, "next", hammer, False),
    ("Inverted Hammer", "BUY", "reversal", 1, -1, "next", inv_hammer, False),
    ("Hanging Man", "SELL", "reversal", 1, 1, "next", hammer, False),
    ("Shooting Star", "SELL", "reversal", 1, 1, "next", inv_hammer, False),
    ("Dragonfly Doji", "BUY", "reversal", 1, -1, "next", dragonfly, False),
    ("Gravestone Doji", "SELL", "reversal", 1, 1, "next", gravestone, False),
    ("Long-Legged Doji", None, "neutral", 1, 0, "next", long_legged, False),
    ("Standard Doji", None, "neutral", 1, 0, "next", std_doji, False),
    ("Spinning Top", None, "neutral", 1, 0, "next", spinning, False),
    ("Bullish Marubozu", "BUY", "continuation", 1, 1, "self", bull_maru, False),
    ("Bearish Marubozu", "SELL", "continuation", 1, -1, "self", bear_maru, False),
    ("Bullish Engulfing", "BUY", "reversal", 2, -1, "self", bull_eng, False),
    ("Bearish Engulfing", "SELL", "reversal", 2, 1, "self", bear_eng, False),
    ("Bullish Harami", "BUY", "reversal", 2, -1, "next", bull_harami, False),
    ("Bearish Harami", "SELL", "reversal", 2, 1, "next", bear_harami, False),
    ("Bullish Harami Cross", "BUY", "reversal", 2, -1, "next", bull_harami_x, False),
    ("Bearish Harami Cross", "SELL", "reversal", 2, 1, "next", bear_harami_x, False),
    ("Piercing Line", "BUY", "reversal", 2, -1, "self", piercing, False),
    ("Dark Cloud Cover", "SELL", "reversal", 2, 1, "self", dark_cloud, False),
    ("Tweezer Bottom", "BUY", "reversal", 2, -1, "next", tweezer_bot, False),
    ("Tweezer Top", "SELL", "reversal", 2, 1, "next", tweezer_top, False),
    ("Bullish Kicker", "BUY", "reversal", 2, 0, "self", bull_kicker, False),
    ("Bearish Kicker", "SELL", "reversal", 2, 0, "self", bear_kicker, False),
    ("Matching Low", "BUY", "reversal", 2, -1, "next", matching_low, False),
    ("Stick Sandwich", "BUY", "reversal", 3, -1, "next", stick_sandwich, False),
    ("Morning Star", "BUY", "reversal", 3, -1, "self", morning_star, False),
    ("Evening Star", "SELL", "reversal", 3, 1, "self", evening_star, False),
    ("Morning Doji Star", "BUY", "reversal", 3, -1, "self", morning_doji, False),
    ("Evening Doji Star", "SELL", "reversal", 3, 1, "self", evening_doji, False),
    ("Three White Soldiers", "BUY", "continuation", 3, 0, "self", soldiers, True),
    ("Three Black Crows", "SELL", "continuation", 3, 0, "self", crows, True),
    ("Three Inside Up", "BUY", "reversal", 3, -1, "self", inside_up, False),
    ("Three Inside Down", "SELL", "reversal", 3, 1, "self", inside_dn, False),
    ("Three Outside Up", "BUY", "reversal", 3, -1, "self", outside_up, False),
    ("Three Outside Down", "SELL", "reversal", 3, 1, "self", outside_dn, False),
    ("Abandoned Baby (Bullish)", "BUY", "reversal", 3, -1, "self", baby_bull, False),
    ("Abandoned Baby (Bearish)", "SELL", "reversal", 3, 1, "self", baby_bear, False),
    ("Rising Three Methods", "BUY", "continuation", 5, 1, "self", rising3, False),
    ("Falling Three Methods", "SELL", "continuation", 5, -1, "self", falling3, False),
    ("Bullish Mat Hold", "BUY", "continuation", 5, 1, "self", mat_hold_bull, False),
    ("Bearish Mat Hold", "SELL", "continuation", 5, -1, "self", mat_hold_bear, False),
    ("Upside Tasuki Gap", "BUY", "continuation", 3, 1, "next", tasuki_up, False),
    ("Downside Tasuki Gap", "SELL", "continuation", 3, -1, "next", tasuki_dn, False),
    ("Inside Bar", None, "neutral", 2, 0, "next", inside_bar, False),
    ("Outside Bar", None, "neutral", 2, 0, "next", outside_bar, False),
    ("Bullish Belt Hold", "BUY", "reversal", 1, -1, "next", bull_belt, False),
    ("Bearish Belt Hold", "SELL", "reversal", 1, 1, "next", bear_belt, False),
    ("Advance Block", "SELL", "warning", 3, 1, "next", advance_block, False),
    ("Deliberation", "SELL", "warning", 3, 1, "next", deliberation, False),
    ("Ladder Bottom", "BUY", "reversal", 5, 0, "self", ladder_bottom, False),
    ("Three Stars in the South", "BUY", "reversal", 3, 0, "next", three_stars, False),
    ("Bullish Separating Lines", "BUY", "continuation", 2, 1, "next", bull_sep, False),
    ("Bearish Separating Lines", "SELL", "continuation", 2, -1, "next", bear_sep, False),
    ("Upside Gap Two Crows", "SELL", "reversal", 3, 1, "next", gap_two_crows, False),
]
assert len(PATTERNS) == 54


@dataclass
class Hit:
    name: str
    side: str | None
    kind: str
    confirm: str
    end: int
    hi: float
    lo: float


@dataclass
class Signal:
    index: int
    side: str
    patterns: list
    entry: float
    stop: float
    score: int


def atr(cs, n):
    w = cs[-n:]
    return sum(x.rng for x in w) / len(w)


def trend(cs, start, P, A):
    """Trend before candle `start`: (+1/-1/0, magnitude in ATRs)."""
    lb = P.trend_lb
    if start - 1 - lb < 0:
        return 0, 0.0
    w = cs[start - 1 - lb: start]
    net = (w[-1].c - w[0].c) / A
    ups = sum(1 for k in range(1, len(w)) if w[k].c > w[k - 1].c) / lb
    if net >= P.trend_atr and ups >= P.trend_agree: return 1, net
    if net <= -P.trend_atr and (1 - ups) >= P.trend_agree: return -1, -net
    return 0, abs(net)


class Engine:
    def __init__(self, params: Params | None = None):
        self.P = params or Params()
        self.cs: list[Candle] = []
        self.pend: list[Hit] = []

    def detect(self, i):
        P, cs = self.P, self.cs
        A = atr(cs[: i + 1], P.atr_n)
        hits = []
        for name, side, kind, span, need, conf, fn, late in PATTERNS:
            s = i - span + 1
            if s < P.trend_lb + 1:
                continue
            c = cs[s: i + 1]
            if not fn(c, A, P):
                continue
            if kind == "neutral" and not P.trade_neutral:
                continue
            d, mag = trend(cs, s, P, A)
            if need and d != need:
                continue
            if late and mag > P.exhaust_atr:
                continue
            hi, lo = max(x.h for x in c), min(x.l for x in c)
            if P.require_level and kind in ("reversal", "warning"):
                prev = cs[max(0, s - P.level_lb): s]
                tol = P.level_tol_atr * A
                if side == "BUY" and lo > min(x.l for x in prev) + tol: continue
                if side == "SELL" and hi < max(x.h for x in prev) - tol: continue
            hits.append(Hit(name, side, kind, "next" if P.confirm_all else conf, i, hi, lo))
        return hits

    def update(self, candle: Candle):
        P = self.P
        self.cs.append(candle)
        i, c = len(self.cs) - 1, candle
        fired, keep = [], []
        for h in self.pend:                      # patterns waiting for confirmation
            if i - h.end > P.confirm_window:
                continue
            if h.side is None:                   # neutral: direction of the break
                if c.c > h.hi: fired.append(("BUY", h)); continue
                if c.c < h.lo: fired.append(("SELL", h)); continue
            elif h.side == "BUY":
                if c.c > h.hi: fired.append(("BUY", h)); continue
                if c.c < h.lo: continue          # invalidated first
            else:
                if c.c < h.lo: fired.append(("SELL", h)); continue
                if c.c > h.hi: continue
            keep.append(h)
        self.pend = keep
        if i >= P.trend_lb + 1:
            for h in self.detect(i):
                if h.confirm == "self" and h.side:
                    fired.append((h.side, h))
                else:
                    self.pend.append(h)
        return self._merge(fired, i)

    def _merge(self, fired, i):
        if not fired:
            return None
        by = {"BUY": [], "SELL": []}
        for side, h in fired:
            by[side].append(h)
        nb, ns = len({h.name for h in by["BUY"]}), len({h.name for h in by["SELL"]})
        if nb == ns:
            return None                          # conflicting evidence: stand aside
        side = "BUY" if nb > ns else "SELL"
        hs, n = by[side], max(nb, ns)
        if n < self.P.min_score:
            return None
        stop = min(h.lo for h in hs) if side == "BUY" else max(h.hi for h in hs)
        return Signal(i, side, sorted({h.name for h in hs}), self.cs[i].c, stop, n)


def run(cs, params=None):
    e = Engine(params)
    return [s for c in cs if (s := e.update(c))]


# ---------------------------------------------------------------- backtests
def binary_backtest(cs, sigs, expiries=(1, 2, 3, 4, 5), payout=0.92, show=True):
    out = {}
    for n in expiries:
        w = l = 0
        per: dict = {}
        for s in sigs:
            j = s.index + n
            if j >= len(cs): continue
            d = cs[j].c - s.entry
            win = d > 0 if s.side == "BUY" else d < 0
            loss = d < 0 if s.side == "BUY" else d > 0
            if not (win or loss): continue
            w += win; l += loss
            for p in s.patterns:
                a = per.setdefault(p, [0, 0]); a[0] += win; a[1] += loss
        t = w + l
        wr = w / t if t else 0
        out[n] = (t, wr, per)
        if show:
            print(f"expiry {n}: trades={t:5d} winrate={wr:6.1%} EV/unit={wr*payout-(1-wr):+.3f}")
    return out


def r_backtest(cs, sigs, rr=1.5, max_bars=20, show=True):
    """Stop at the pattern's invalidation level, target = rr * risk. Stop wins a same-candle tie."""
    rs = []
    for s in sigs:
        risk = abs(s.entry - s.stop)
        if risk <= 0: continue
        tgt = s.entry + rr * risk if s.side == "BUY" else s.entry - rr * risk
        r = None
        for j in range(s.index + 1, min(len(cs), s.index + 1 + max_bars)):
            x = cs[j]
            if s.side == "BUY":
                if x.l <= s.stop: r = -1; break
                if x.h >= tgt: r = rr; break
            else:
                if x.h >= s.stop: r = -1; break
                if x.l <= tgt: r = rr; break
        if r is None:
            end = cs[min(len(cs) - 1, s.index + max_bars)].c
            r = ((end - s.entry) if s.side == "BUY" else (s.entry - end)) / risk
        rs.append(r)
    n = len(rs)
    if show and n:
        print(f"R-test (target {rr}R, stop at pattern invalidation): trades={n} avg R={sum(rs)/n:+.3f} hit-rate={sum(1 for r in rs if r>0)/n:.1%}")
    return rs


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
        print(f"{len(PATTERNS)} patterns loaded.\nusage: python candlestick_engine.py candles.csv [--confirm-all] [--level]")
        sys.exit(0)
    P = Params(confirm_all="--confirm-all" in sys.argv, require_level="--level" in sys.argv)
    cs = load_csv(sys.argv[1])
    sigs = run(cs, P)
    print(f"{len(cs)} candles, {len(sigs)} signals ({sum(s.side=='BUY' for s in sigs)} buy / {sum(s.side=='SELL' for s in sigs)} sell)\n")
    res = binary_backtest(cs, sigs)
    r_backtest(cs, sigs)
    n3 = res[3][2]
    print("\nPer-pattern, expiry 3 (min 15 trades):")
    for p, (w, l) in sorted(n3.items(), key=lambda kv: -(kv[1][0] / max(1, sum(kv[1])))):
        if w + l >= 15:
            print(f"  {p:28s} trades={w+l:4d} winrate={w/(w+l):6.1%}")
