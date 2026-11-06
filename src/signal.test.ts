import test from "node:test";
import assert from "node:assert/strict";
import { getSignal, parseAi, merge, buildPrompt, EngineResult, Cand } from "../signalServer";

const eng = (o: Partial<EngineResult> = {}): EngineResult => ({
  status: "setup", setup: true, side: "BUY", confidence: 68, agree: 2, candles: 200,
  sweep: { side: "BUY", reasons: ["wick rejection"] }, indicators: { side: "BUY", strategies: ["S1", "S2"], count: 2 }, pattern: null,
  reasons: ["liquidity sweep (BUY)", "2 indicator strategies agree: S1, S2"], ...o,
});
const candles = (n = 150): Cand[] => Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 60, open: 1, high: 1.1, low: 0.9, close: 1.05 }));
const NOW = (1000 + 150 * 60 + 5) * 1000;   // the 150th candle (index 149) is closed, a new one just started

test("no engine setup means no AI call and no trade", async () => {
  let calls = 0;
  const s = await getSignal({ engines: async () => eng({ setup: false, side: null, status: "no liquidity sweep" }), ai: async () => { calls++; return ""; }, now: () => NOW }, candles(), 60, "EURUSD", "k1");
  assert.equal(calls, 0); assert.equal(s.setup, false); assert.equal(s.tradeable, false);
});

test("AI approves: tradeable, confidence moved only by the bounded adjustment", async () => {
  const s = await getSignal({ engines: async () => eng(), ai: async () => '{"verdict":"approve","confidenceAdjust":50,"reason":"clean rejection","risks":[]}', now: () => NOW }, candles(), 60, "EURUSD", "k2");
  assert.equal(s.tradeable, true); assert.equal(s.side, "buy"); assert.equal(s.confidence, 73);
});

test("AI veto cancels the setup", async () => {
  const s = await getSignal({ engines: async () => eng(), ai: async () => '```json\n{"verdict":"veto","confidenceAdjust":-10,"reason":"fights a strong trend"}\n```', now: () => NOW }, candles(), 60, "EURUSD", "k3");
  assert.equal(s.setup, false); assert.equal(s.tradeable, false); assert.match(s.status, /vetoed/);
});

test("no AI key or a broken AI reply never makes a tradeable signal", async () => {
  const a = await getSignal({ engines: async () => eng(), ai: null, now: () => NOW }, candles(), 60, "EURUSD", "k4");
  assert.equal(a.tradeable, false); assert.equal(a.setup, true); assert.equal(a.ai?.status, "unavailable");
  const b = await getSignal({ engines: async () => eng(), ai: async () => "I think buy", now: () => NOW }, candles(), 60, "EURUSD", "k5");
  assert.equal(b.tradeable, false);
  const c = await getSignal({ engines: async () => eng(), ai: async () => { throw new Error("boom"); }, now: () => NOW }, candles(), 60, "EURUSD", "k6");
  assert.equal(c.tradeable, false);
});

test("the same candle is only sent to the AI once", async () => {
  let calls = 0;
  const d = { engines: async () => eng(), ai: async () => { calls++; return '{"verdict":"approve","confidenceAdjust":0,"reason":"ok"}'; }, now: () => NOW };
  await getSignal(d, candles(), 60, "EURUSD", "k7"); await getSignal(d, candles(), 60, "EURUSD", "k7");
  assert.equal(calls, 1);
});

test("parse + prompt basics", () => {
  assert.throws(() => parseAi('{"verdict":"maybe"}'));
  assert.equal(parseAi('{"verdict":"approve","confidenceAdjust":-99,"reason":"x"}').adjust, -15);
  const p = buildPrompt(eng(), candles(), 60, "EURUSD");
  assert.match(p, /VETO/); assert.match(p, /EURUSD/); assert.equal(p.split("\n").filter((l) => /^\d+,/.test(l)).length, 60);
  assert.equal(merge(eng(), null, 0, 60).tradeable, false);
});
