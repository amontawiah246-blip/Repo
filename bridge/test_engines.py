import random, time, unittest
from engines import combine as C, sweep_engine as SW, indicator_engine as IN

def walk(n, seed, tf=60, vol=0.0004):
    r = random.Random(seed); p = 1.1; out = []; t0 = 1_700_000_000 // tf * tf
    for i in range(n):
        o = p
        pts = [o]
        for _ in range(4): pts.append(pts[-1] * (1 + r.gauss(0, vol)))
        c = pts[-1]; h = max(pts) * (1 + abs(r.gauss(0, vol / 3))); l = min(pts) * (1 - abs(r.gauss(0, vol / 3)))
        out.append({"time": t0 + i * tf, "open": o, "high": h, "low": l, "close": c}); p = c
    return out

class T(unittest.TestCase):
    def test_short_history(self):
        r = C.evaluate(walk(50, 1), now=2_000_000_000)
        self.assertFalse(r["setup"]); self.assertIn("need", r["status"])

    def test_forming_candle_dropped(self):
        cs = walk(200, 2); now = cs[-1]["time"] + 10   # last candle still forming
        self.assertEqual(C.evaluate(cs, now=now)["candles"], 199)
        self.assertEqual(C.evaluate(cs, now=now + 100)["candles"], 200)

    def test_random_data_runs(self):
        setups = 0; total = 0
        for seed in range(15):
            cs = walk(400, seed)
            for end in range(150, 400, 5):
                r = C.evaluate(cs[:end], now=2_000_000_000); total += 1
                if r["setup"]:
                    setups += 1
                    self.assertIn(r["side"], ("BUY", "SELL")); self.assertGreaterEqual(r["agree"], 1)
                    if r["sweep"]: self.assertEqual(r["sweep"]["side"], r["side"])   # the sweep always keeps its side
        print(f"\nrandom data: {total} looks, {setups} setups")

    def _fake(self, sweep, ind, pat):
        class F:
            def __init__(s, **k): s.__dict__.update(k)
        o = (SW.check, IN.Engine, C.CS.Engine)
        SW.check = (lambda cs, i, p=None: SW.Signal(sweep, i, ["wick"])) if sweep else (lambda *a, **k: None)
        def mk(sig):
            class E:
                def __init__(s, p=None): s.n = 0
                def update(s, c):
                    s.n += 1
                    return sig if s.n >= 139 else None
            return E
        IN.Engine = mk(F(index=1, side=ind[0], strategies=ind[1], entry=1, info={}) if ind else None)
        C.CS.Engine = mk(F(index=1, side=pat, patterns=["hammer"], entry=1, stop=1, score=1) if pat else None)
        try: return C.evaluate(walk(200, 3), now=2_000_000_000)
        finally: SW.check, IN.Engine, C.CS.Engine = o

    def test_any_engine_can_trade_and_agreement_raises_confidence(self):
        sweep = self._fake("BUY", None, None); ind = self._fake(None, ("BUY", ["S1"]), None); pat = self._fake(None, None, "BUY")
        pair = self._fake("BUY", ("BUY", ["S1", "S2"]), None); allthree = self._fake("BUY", ("BUY", ["S1", "S2"]), "BUY")
        ip = self._fake(None, ("BUY", ["S1"]), "BUY")
        for r in (sweep, ind, pat): self.assertTrue(r["setup"]); self.assertEqual(r["agree"], 1)
        self.assertTrue(pair["setup"]); self.assertEqual(pair["agree"], 2); self.assertEqual(allthree["agree"], 3)
        self.assertGreater(pair["confidence"], max(sweep["confidence"], ind["confidence"], pat["confidence"]))
        self.assertGreater(allthree["confidence"], pair["confidence"])
        self.assertGreater(ip["confidence"], pat["confidence"])   # a pattern backed by indicators beats a pattern alone

    def test_sweep_wins_a_conflict_but_with_low_confidence(self):
        r = self._fake("BUY", ("SELL", ["S1", "S2"]), None)
        self.assertTrue(r["setup"]); self.assertEqual(r["side"], "BUY"); self.assertLess(r["confidence"], 60)
        r2 = self._fake(None, ("SELL", ["S1", "S2"]), "BUY")
        self.assertFalse(r2["setup"]); self.assertIn("opposite", r2["status"])

    def test_known_sweep_is_found_whatever_the_clock_offset(self):
        cs = walk(500, 5)
        sw = [SW.Candle(str(c["time"]), c["open"], c["high"], c["low"], c["close"]) for c in cs]
        idx = [s.index for s in SW.run(sw) if s.index > 150][2]
        closed = cs[:idx + 1]
        forming = {"time": closed[-1]["time"] + 60, "open": 1, "high": 1, "low": 1, "close": 1}
        for off in (0, 7200, -7200, 3600):     # candle times and the broker clock share the same offset
            now = forming["time"] + 20 + off
            cc = [dict(c, time=c["time"] + off) for c in closed + [forming]]
            r = C.evaluate(cc, now=now)
            self.assertEqual(r["candles"], len(closed)); self.assertTrue(r["sweep"])

    def test_nothing_no_setup(self):
        self.assertFalse(self._fake(None, None, None)["setup"])

if __name__ == "__main__": unittest.main(verbosity=1)
