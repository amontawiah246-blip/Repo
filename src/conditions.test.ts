import test from "node:test";
import assert from "node:assert/strict";
import { marketCondition, setupKind, Bar } from "./conditions";

const mk = (f: (i: number) => number, n = 80, w = 0.0004): Bar[] => Array.from({ length: n }, (_, i) => {
  const o = f(i), c = f(i + 1); return { time: 1000 + i * 60, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w };
});

test("too few candles gives nothing", () => assert.equal(marketCondition(mk(() => 1, 20)), null));

test("steady rise reads as an up trend with rising averages", () => {
  const c = marketCondition(mk((i) => 1 + i * 0.001))!;
  assert.equal(c.trend, "Up"); assert.equal(c.ema.state, "Rising"); assert.ok(c.trendStrength > 60); assert.ok(c.rsi > 60);
});

test("a flat zig-zag reads as sideways", () => {
  const c = marketCondition(mk((i) => 1 + (i % 2 ? 0.0003 : -0.0003)))!;
  assert.equal(c.trend, "Sideways"); assert.ok(c.trendStrength < 20);
});

test("a wick above the recent highs that closes back below is a sweep above highs", () => {
  const b = mk((i) => 1 + Math.sin(i / 3) * 0.002);
  const top = Math.max(...b.slice(-21, -1).map((x) => x.high));
  b[b.length - 1] = { time: b[b.length - 1].time, open: top - 0.0002, high: top + 0.0008, low: top - 0.0006, close: top - 0.0004 };
  const c = marketCondition(b)!;
  assert.equal(c.priceAction, "Sweep above highs"); assert.ok(c.notes.some((t) => /sweep above/i.test(t)));
  assert.ok(c.support < c.resistance);
});

test("setup names", () => {
  const up = marketCondition(mk((i) => 1 + i * 0.001))!;
  assert.equal(setupKind("buy", up, ["ind"]), "Trend continuation");
  assert.equal(setupKind("sell", up, ["sweep"]), "Liquidity sweep reversal");
  assert.equal(setupKind(null, up, []), "None");
});
