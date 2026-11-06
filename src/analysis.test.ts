import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, outcomeOf, rsi, ema, Candle } from './analysis';

function series(n: number, step: (i: number) => number, start = 1.1): Candle[] {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const out: Candle[] = []; let px = start;
  for (let i = 0; i < n; i++) {
    const o = px, c = o + step(i) + rnd() * 0.00015;
    out.push({ time: 1000 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.00008, low: Math.min(o, c) - 0.00008 });
    px = c;
  }
  return out;
}

test('needs enough candles', () => assert.equal(analyze(series(10, () => 0)), null));
test('steady rise -> buy side', () => {
  const a = analyze(series(120, () => 0.0003))!;
  assert.ok(a.score > 0); assert.equal(a.side, 'buy'); assert.ok(a.reasons.length >= 2);
});
test('steady fall -> sell side', () => {
  const a = analyze(series(120, () => -0.0003))!;
  assert.ok(a.score < 0); assert.equal(a.side, 'sell');
});
test('confidence stays in range and strength matches', () => {
  for (const f of [() => 0.0005, () => -0.0005, (i: number) => Math.sin(i / 3) * 0.0004, () => 0]) {
    const a = analyze(series(100, f))!;
    assert.ok(a.confidence >= 51 && a.confidence <= 94, String(a.confidence));
    const exp = a.confidence < 60 ? 'Low' : a.confidence < 72 ? 'Medium' : a.confidence < 84 ? 'High' : 'Very high';
    assert.equal(a.strength, exp);
  }
});
test('dead flat market is flagged and low confidence', () => {
  const flat = Array.from({ length: 80 }, (_, i) => ({ time: i * 60, open: 1.1, high: 1.1, low: 1.1, close: 1.1 }));
  const a = analyze(flat)!;
  assert.ok(a.confidence < 60); assert.ok(a.reasons.some((r) => /flat/i.test(r.text)));
});
test('hard sell-off then hammer leans buy (oversold bounce)', () => {
  const c = series(60, () => -0.0004);
  const l = c[c.length - 1];
  c.push({ time: l.time + 60, open: l.close, close: l.close + 0.00005, high: l.close + 0.00012, low: l.close - 0.0012 });
  assert.equal(analyze(c)!.side, 'buy');
});
test('indicator helpers', () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i)), 100);
  assert.ok(rsi(Array.from({ length: 30 }, (_, i) => 30 - i)) < 1);
  assert.equal(ema([2, 2, 2], 3).at(-1), 2);
});
test('outcomes', () => {
  assert.equal(outcomeOf('buy', 1, 1.1), 'win'); assert.equal(outcomeOf('buy', 1, 0.9), 'loss');
  assert.equal(outcomeOf('sell', 1, 0.9), 'win'); assert.equal(outcomeOf('sell', 1, 1), 'draw');
});
