"""
Combines the three engines. They never overlap: each one only reads candles and returns its own verdict.

  Any engine can trigger a trade on its own (sweep, indicator strategies, candlestick pattern).
  Engines that agree raise the confidence:  sweep + indicators = the high-probability pair;
  a candlestick pattern backed by the indicators (or by the sweep) is stronger than one alone; all three = highest.
  Engines that point in opposite directions cancel the setup.

Candles passed in must be CLOSED candles, oldest first: [{time,open,high,low,close}, ...].
"""
from __future__ import annotations
import time as _time
from . import sweep_engine as SW, indicator_engine as IN, candlestick_engine as CS

MIN_CANDLES = 140          # the indicator engine needs ~120 bars of warm-up
IND_LOOKBACK = 1           # an indicator vote may be 1 candle older than the sweep candle


def _closed(candles, tf, now):
    if now is None:
        now = _time.time()
    if candles and candles[-1]["time"] >= int(now // tf * tf):
        return candles[:-1]
    return candles


def evaluate(candles, tf=60, min_ind=1, now=None, drop_forming=True):
    cs = _closed(candles, tf, now) if drop_forming else list(candles)
    out = {"setup": False, "side": None, "confidence": 0, "agree": 0, "candles": len(cs),
           "sweep": None, "indicators": None, "pattern": None, "reasons": [], "status": "watching"}
    if len(cs) < MIN_CANDLES:
        out["status"] = f"need {MIN_CANDLES} candles, have {len(cs)}"
        return out
    last = len(cs) - 1
    t = lambda c: str(c["time"])

    # ---- 1. sweep engine (boss)
    sw_c = [SW.Candle(t(c), c["open"], c["high"], c["low"], c["close"]) for c in cs]
    sg = SW.check(sw_c, last, SW.Params())
    if sg:
        out["sweep"] = {"side": sg.side, "reasons": sg.reasons[:4]}

    # ---- 2. indicator engine (stateful: replay, keep the newest votes)
    ie = IN.Engine(IN.Params(min_votes=1))
    ind = None
    for k, c in enumerate(cs):
        s = ie.update(IN.Candle(t(c), c["open"], c["high"], c["low"], c["close"]))
        if s and k >= last - IND_LOOKBACK:
            ind = s    # newest wins
    if ind:
        out["indicators"] = {"side": ind.side, "strategies": list(ind.strategies), "count": len(ind.strategies),
                             "info": ind.info}

    # ---- 3. candlestick engine
    ce = CS.Engine(CS.Params(trade_neutral=False))   # doji / inside-bar style patterns carry no direction of their own
    pat = None
    for k, c in enumerate(cs):
        s = ce.update(CS.Candle(t(c), c["open"], c["high"], c["low"], c["close"]))
        if s and k >= last - IND_LOOKBACK:
            pat = s
    if pat:
        out["pattern"] = {"side": pat.side, "patterns": list(pat.patterns), "stop": pat.stop, "counted": False}

    # ---- decision: any engine may trigger a trade; agreement between engines raises the confidence
    sides = {}
    if sg: sides["sweep"] = sg.side
    if ind: sides["ind"] = ind.side
    if pat: sides["pat"] = pat.side
    if not sides:
        out["status"] = "no engine sees a setup on the newest candle"
        return out
    conflict = ""
    if len(set(sides.values())) > 1:
        if "sweep" not in sides:
            out["status"] = "indicators and candle pattern point in opposite directions, standing aside"
            return out
        # the sweep is the boss: it keeps its side, but opposing engines pull the confidence below the usual bar
        opp = [k for k, v in sides.items() if v != sides["sweep"]]
        conflict = "+".join(opp)
        sides = {k: v for k, v in sides.items() if v == sides["sweep"]}
        if ind and ind.side != sg.side: ind = None
        if pat and pat.side != sg.side: pat = None; out["pattern"]["counted"] = False
    side = next(iter(sides.values()))
    n_ind = len(ind.strategies) if ind else 0
    if "ind" in sides and "sweep" not in sides and n_ind < min_ind and len(sides) == 1:
        out["status"] = f"only {n_ind}/{min_ind} indicator strategies, not enough on their own"
        return out
    kinds = set(sides)
    if kinds == {"sweep", "ind", "pat"}:
        conf = 80 + 3 * (n_ind - 1)
    elif kinds == {"sweep", "ind"}:
        conf = 72 + 4 * (n_ind - 1)                  # the high-probability pair
    elif kinds == {"ind", "pat"}:
        conf = 68 + 3 * (n_ind - 1)
    elif kinds == {"sweep", "pat"}:
        conf = 66
    elif kinds == {"sweep"}:
        conf = 62
    elif kinds == {"ind"}:
        conf = 60 + 4 * (n_ind - 1)
    else:
        conf = 56 + 2 * (pat.score - 1)              # a pattern alone is the weakest trigger
    reasons = []
    if conflict:
        conf = 56
        reasons.append(f"opposed by: {conflict} (confidence reduced)")
    if sg: reasons.append(f"liquidity sweep ({side}): " + "; ".join(sg.reasons[:2]))
    if ind: reasons.append(f"{n_ind} indicator strategies agree: " + ", ".join(ind.strategies))
    if pat:
        out["pattern"]["counted"] = True
        reasons.append("candlestick pattern: " + ", ".join(pat.patterns[:3]))
    out.update(setup=True, side=side, agree=len(kinds), confidence=min(conf, 92), reasons=reasons,
               status="setup", engines=sorted(kinds))
    return out
