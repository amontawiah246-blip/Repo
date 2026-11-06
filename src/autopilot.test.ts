import test from 'node:test';
import assert from 'node:assert/strict';
import { Autopilot, Deps, DEFAULT_CFG, MarketRef } from './autopilot';
import { Candle, analyze } from './analysis';

function series(n: number, step: number, start = 1.1): Candle[] {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const out: Candle[] = []; let px = start;
  for (let i = 0; i < n; i++) { const o = px, c = o + step + rnd() * 0.00015; out.push({ time: i * 60, open: o, close: c, high: Math.max(o, c) + 8e-5, low: Math.min(o, c) - 8e-5 }); px = c; }
  return out;
}
const flat = Array.from({ length: 80 }, (_, i) => ({ time: i * 60, open: 1.1, high: 1.1, low: 1.1, close: 1.1 }));

function rig(opts: { markets: MarketRef[]; data: Record<string, Candle[]>; exit?: (sym: string) => number; placeOk?: boolean; official?: (id: string) => { outcome: any; profit: number | null } | null }) {
  const placed: any[] = []; const picked: string[] = []; let sleeps = 0;
  const deps: Deps = {
    assets: () => opts.markets,
    watch: async (sym) => { const c = opts.data[sym]; if (!c) throw new Error('no data'); const last = c[c.length - 1].close; let n = 0; return { candles: c, price: () => (++n === 1 || !opts.exit ? last : opts.exit(sym)), close() {} }; },
    place: async (symbol, side, stake, seconds) => { placed.push({ symbol, side, stake, seconds }); return opts.placeOk === false ? { ok: false, msg: 'rejected' } : { ok: true, msg: 'ok', id: 't' + placed.length }; },
    ...(opts.official ? { result: async (id: string) => opts.official!(id) } : {}),
    sleep: async () => { if (++sleeps > 400) throw new Error('runaway loop'); await Promise.resolve(); },
    onPick: (s) => picked.push(s),
  };
  return { deps, placed, picked, data: opts.data };
}
const M = (symbol: string, payout = 90): MarketRef => ({ symbol, label: symbol, payout, active: true });
const cfg = { ...DEFAULT_CFG, minConf: 55, maxTrades: 2 };

test('picks the strongest market, trades it, books a win, then hits the trade limit', async () => {
  const r = rig({ markets: [M('FLAT'), M('UP'), M('DOWN')], data: { FLAT: flat, UP: series(120, 0.0003), DOWN: series(120, -0.0001) }, exit: () => 99 });
  const ap = new Autopilot(r.deps, cfg); await ap.start();
  assert.equal(ap.state.phase, 'stopped'); assert.match(ap.state.stopReason, /limit of 2 trades/);
  const conf = (k: string) => analyze(r.data[k].slice(0, -1))!.confidence;
  const bestSym = ['UP', 'DOWN'].sort((a, b) => conf(b) - conf(a))[0];
  assert.equal(r.placed.length, 2); assert.equal(r.placed[0].symbol, bestSym);
  assert.equal(r.placed[0].stake, 10); assert.equal(r.placed[0].seconds, 60);
  assert.ok(r.picked.includes(bestSym)); assert.equal(ap.state.stats.wins + ap.state.stats.losses, 2); 
});
test('stops after consecutive losses', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, exit: () => 0.5 });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 50, maxLossStreak: 2 }); await ap.start();
  assert.match(ap.state.stopReason, /2 losses in a row/); assert.equal(ap.state.stats.losses, 2); assert.equal(ap.state.stats.pnl, -20);
});
test('stops at the loss limit', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, exit: () => 0.5 });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 50, maxLossStreak: 9, stopLoss: 15 }); await ap.start();
  assert.match(ap.state.stopReason, /Loss limit/);
});
test('3 rejected orders stop the engine', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, placeOk: false });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 50 }); await ap.start();
  assert.match(ap.state.stopReason, /rejected 3 trades/); assert.equal(ap.state.stats.trades, 0);
});
test('no setup above the confidence bar places nothing', async () => {
  const r = rig({ markets: [M('FLAT')], data: { FLAT: flat } });
  const ap = new Autopilot(r.deps, { ...cfg, minConf: 90 });
  let rounds = 0; const orig = r.deps.sleep; r.deps.sleep = async (ms) => { if (++rounds > 3) ap.stop('test over'); await orig(ms); };
  await ap.start(); assert.equal(r.placed.length, 0); assert.equal(ap.state.stopReason, 'test over');
});
test('markets below the payout filter and closed markets are never scanned', async () => {
  const seen: string[] = [];
  const r = rig({ markets: [M('LOW', 60), { ...M('CLOSED'), active: false }, M('UP')], data: { LOW: series(120, 0.0003), CLOSED: series(120, 0.0003), UP: series(120, 0.0003) } });
  const w = r.deps.watch; r.deps.watch = async (s, t) => { seen.push(s); return w(s, t); };
  await new Autopilot(r.deps, { ...cfg, maxTrades: 1 }).start();
  assert.ok(!seen.includes('LOW') && !seen.includes('CLOSED') && seen.includes('UP'));
});
test('unreadable data 5 rounds in a row stops the engine', async () => {
  const r = rig({ markets: [M('X')], data: {} });
  const ap = new Autopilot(r.deps, cfg); await ap.start();
  assert.match(ap.state.stopReason, /market data/);
});
test('stop() ends a running trade wait without booking a result', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, exit: () => 99 });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 5 });
  r.deps.sleep = () => new Promise<void>(() => {});     // sleeps forever, only stop() can end it
  const p = ap.start(); await new Promise((x) => setTimeout(x, 30));
  assert.equal(ap.state.phase, 'running'); ap.stop('Stopped by you'); await p;
  assert.equal(ap.state.stats.wins + ap.state.stats.losses, 0); assert.equal(ap.state.phase, 'stopped');
});

test('official broker result wins over the price estimate and uses the real profit', async () => {
  // price says WIN (exit above entry) but the broker says LOSS with a -10 profit
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, exit: () => 99, official: () => ({ outcome: 'loss', profit: -10 }) });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.equal(ap.state.stats.losses, 1); assert.equal(ap.state.stats.wins, 0); assert.equal(ap.state.stats.pnl, -10); assert.equal(ap.state.stats.estimated, 0);
  assert.ok(ap.state.log.some((l) => /LOSS/.test(l.text) && !/estimated/.test(l.text)));
});
test('official win books the broker profit, not stake x payout', async () => {
  const r = rig({ markets: [M('UP', 90)], data: { UP: series(120, 0.0003) }, official: () => ({ outcome: 'win', profit: 7.25 }) });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.equal(ap.state.stats.pnl, 7.25);
});
test('when the broker result cannot be read the engine falls back to the estimate', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) }, exit: () => 99, official: () => null });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.equal(ap.state.stats.estimated, 1); assert.equal(ap.state.stats.wins + ap.state.stats.losses, 1);
});
test('focus tells the UI which market the bot is working on', async () => {
  const r = rig({ markets: [M('UP')], data: { UP: series(120, 0.0003) } });
  const ap = new Autopilot(r.deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.equal(ap.state.focus, 'UP');
});

test('the analyser from the deps decides, and markets with an unknown payout are skipped', async () => {
  const seen: string[] = [];
  const r = rig({ markets: [M('AAA'), { symbol: 'NOPAY', label: 'NOPAY', payout: null, active: true }], data: { AAA: series(120, 0.0003), NOPAY: series(120, 0.0003) } });
  const deps = { ...r.deps, analyze: async (sym: string) => { seen.push(sym); return { side: 'sell' as const, confidence: 80, why: 'test' }; } };
  const ap = new Autopilot(deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.deepEqual([...new Set(seen)], ['AAA']);
  assert.equal(r.placed[0].side, 'sell');
});

test('a market with no setup shows its reason, it is not reported as unreadable', async () => {
  const r = rig({ markets: [M('AAA')], data: { AAA: series(120, 0.0003) } });
  let n = 0;
  const deps = { ...r.deps, analyze: async () => (++n <= 2 ? { none: 'no liquidity sweep' } : { side: 'buy' as const, confidence: 80 }) };
  const ap = new Autopilot(deps, { ...cfg, maxTrades: 1 }); await ap.start();
  assert.ok(ap.state.log.some((l) => /no liquidity sweep/.test(l.text)));
  assert.ok(!ap.state.log.some((l) => /Could not read any market/.test(l.text)));
});
