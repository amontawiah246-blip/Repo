"""
Liquidity sweep engine with context filter.

BUY : green candle (closes above its OWN open) whose WICK sweeps below the low of a red candle (body stays above it).
SELL: red candle (closes below its OWN open) whose WICK sweeps above the high of a green candle (body stays below it).

Context filter (the "did sellers/buyers actually try?" check):
  SELL only if sellers were visibly pushing down before the sweep AND buyers
  were not in firm control. BUY is the exact mirror.

Sell logic is run by mirroring prices (x -> -x) and reusing the buy logic.
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
    def rng(self): return max(self.h - self.l, 1e-12)
    @property
    def body(self): return abs(self.c - self.o)
    @property
    def green(self): return self.c > self.o
    @property
    def red(self): return self.c < self.o
    def mirror(self) -> "Candle":
        return Candle(self.t, -self.o, -self.l, -self.h, -self.c)


@dataclass
class Params:
    lookback: int = 6            # candles before the sweep candle that we study
    min_opposite_evidence: int = 2   # min "sellers tried" signs (for a buy: "buyers tried")
    max_strength_ratio: float = 0.5  # max share of strong "with-the-trend" candles allowed
    strong_body: float = 0.6     # body/range for a candle to count as strong
    wick_reject: float = 0.4     # wick/range that counts as rejection
    min_sweep_atr: float = 0.0   # sweep depth must exceed this * ATR (0 = off)


@dataclass
class Signal:
    side: str                    # "BUY" | "SELL"
    index: int
    reasons: list = field(default_factory=list)


def atr(cs: list[Candle]) -> float:
    return sum(c.rng for c in cs) / len(cs) if cs else 0.0


def _buy_check(cs: list[Candle], i: int, p: Params):
    """Buy logic on candle list `cs` at index i. Returns (ok, reasons)."""
    if i < p.lookback + 1:
        return False, ["not enough history"]
    cur, swept = cs[i], cs[i - 1]
    # 1) pattern
    if not (swept.red and cur.green):
        return False, ["colors"]
    if not cur.l < swept.l:
        return False, ["no sweep of low"]
    # cur.green already means close > its OWN open.
    # WICK sweep only: the body (open and close) must stay on the safe side of the
    # swept low; only the wick may poke through. A body that breaks it = breakout, skip.
    if min(cur.o, cur.c) < swept.l:
        return False, ["body broke the level (not a wick sweep)"]
    window = cs[i - 1 - p.lookback: i - 1]       # candles before the swept one
    a = atr(window) or cur.rng
    if (swept.l - cur.l) < p.min_sweep_atr * a:
        return False, ["sweep too shallow"]

    # 2) context: for a BUY, were BUYERS trying to push up (or at least was the
    #    market not in firm bearish control)?
    zone = window[-p.lookback:] + [swept]
    buyers_tried, sellers_firm = 0, 0
    reasons = []
    for k, c in enumerate(zone):
        prev = zone[k - 1] if k else window[0]
        lower_wick = (min(c.o, c.c) - c.l) / c.rng  # (upper wick when mirrored for SELL)
        if lower_wick >= p.wick_reject:
            buyers_tried += 1; reasons.append(f"wick rejection @-{len(zone)-k}")
        elif c.green and c.body / c.rng >= p.strong_body:
            buyers_tried += 1; reasons.append(f"strong with-direction body @-{len(zone)-k}")
        elif c.l < prev.l and c.c > prev.c:
            buyers_tried += 1; reasons.append(f"low swept & bought back @-{len(zone)-k}")
        if c.red and c.body / c.rng >= p.strong_body and c.c <= c.l + 0.2 * c.rng:
            sellers_firm += 1                      # red, big body, closes at its low
    strength = sellers_firm / len(zone)
    # swept candle itself being a full-conviction red candle = sellers still in control
    if swept.body / swept.rng >= 0.8 and swept.c <= swept.l + 0.1 * swept.rng:
        strength += 0.25; reasons.append("swept candle is full-conviction red")
    if buyers_tried < p.min_opposite_evidence:
        return False, ["buyers never tried"] + reasons
    if strength > p.max_strength_ratio:
        return False, [f"sellers still in firm control ({strength:.2f})"] + reasons
    return True, reasons


def check(cs: list[Candle], i: int, p: Params = Params()) -> Signal | None:
    ok, why = _buy_check(cs, i, p)
    if ok:
        return Signal("BUY", i, why)
    m = [c.mirror() for c in cs[max(0, i - p.lookback - 2): i + 1]]
    ok, why = _buy_check(m, len(m) - 1, p) if len(m) == min(len(cs), p.lookback + 3) else (False, [])
    if ok:
        return Signal("SELL", i, why)
    return None


def run(cs: list[Candle], p: Params = Params()) -> list[Signal]:
    return [s for i in range(len(cs)) if (s := check(cs, i, p))]


def backtest(cs: list[Candle], p: Params = Params(), expiries=(1, 2, 3, 4, 5), payout=0.92):
    sigs = run(cs, p)
    for n in expiries:
        w = l = 0
        for s in sigs:
            j = s.index + n
            if j >= len(cs):
                continue
            up = cs[j].c > cs[s.index].c
            dn = cs[j].c < cs[s.index].c
            if (s.side == "BUY" and up) or (s.side == "SELL" and dn): w += 1
            elif (s.side == "BUY" and dn) or (s.side == "SELL" and up): l += 1
        t = w + l
        wr = w / t if t else 0
        ev = wr * payout - (1 - wr)
        print(f"expiry {n}: trades={t:4d} wins={w:4d} winrate={wr:6.1%} EV/unit={ev:+.3f}")
    return sigs


def load_csv(path: str) -> list[Candle]:
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            r = {k.lower(): v for k, v in r.items()}
            out.append(Candle(r.get("time") or r.get("epoch") or r.get("date") or "",
                              float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python sweep_engine.py candles.csv   (cols: time,open,high,low,close)")
        sys.exit(0)
    candles = load_csv(sys.argv[1])
    sigs = backtest(candles)
    print(f"\n{len(sigs)} signals. Last 5:")
    for s in sigs[-5:]:
        print(s.side, candles[s.index].t, "|", "; ".join(s.reasons[:3]))
