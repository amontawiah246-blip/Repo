// "Auto" on the Signals page: scans every open market of the broker with the three engines + the AI check,
// and stops at the best verified setup. It runs here on the server, so the chart is never touched.
import type { Express } from 'express';
import type { Asset } from './src/assets';
import { getSignal, liveDeps } from './signalServer';
import { makeServerDeps } from './autoServer';

const BROKERS = ['pocket', 'quotex', 'iqoption', 'deriv'];

interface Top { symbol: string; label: string; side: 'buy' | 'sell'; confidence: number; verified: boolean }
export interface ScanState {
  running: boolean; found: boolean; broker: string; tfSec: number; pass: number;
  total: number; done: number; failed: number; message: string; best: Top | null; top: Top[]; at: number;
}
const blank = (): ScanState => ({ running: false, found: false, broker: '', tfSec: 60, pass: 0, total: 0, done: 0, failed: 0, message: '', best: null, top: [], at: Date.now() });
let state = blank();
let token = 0;

const CONCURRENCY = 6;

async function loop(port: number, broker: string, tfSec: number, minPayout: number, initial: Asset[], my: number) {
  const deps = makeServerDeps(port, broker, initial);
  const sig = liveDeps(port);
  const alive = () => my === token;
  while (alive()) {
    const pool = deps.assets().filter((a) => a.active !== false && (a.payout ?? 0) >= minPayout).sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0));
    state = { ...state, pass: state.pass + 1, total: pool.length, done: 0, failed: 0, top: [], best: null, message: pool.length ? `Scanning ${pool.length} markets` : 'No open markets match', at: Date.now() };
    const hits: (Top & { age: number; payout: number; aiOff: boolean })[] = [];
    let next = 0, aiOff = false;
    const worker = async () => {
      while (alive()) {
        const i = next++; if (i >= pool.length) return;
        const m = pool[i];
        try {
          const w = await deps.watch(m.symbol, tfSec);
          try {
            const clk = w.clock?.() ?? Date.now() / 1000;
            const s = await getSignal(sig, w.candles, tfSec, m.label, `${broker}:${m.symbol}`, clk);
            if (s.setup && s.side) {
              if (!s.tradeable) aiOff = aiOff || s.ai?.status === 'unavailable';
              const age = clk - (s.candleTime + tfSec);
              if (age <= Math.max(20, tfSec * 0.5) || !s.tradeable) hits.push({ symbol: m.symbol, label: m.label, side: s.side, confidence: s.confidence, verified: s.tradeable, age, payout: m.payout ?? 0, aiOff });
            }
          } finally { w.close(); }
          state = { ...state, done: state.done + 1 };
        } catch { state = { ...state, done: state.done + 1, failed: state.failed + 1 }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pool.length)) }, worker));
    if (!alive()) return;
    const ranked = hits.filter((h) => h.verified).sort((a, b) => b.confidence - a.confidence || b.payout - a.payout);
    const top = ranked.slice(0, 5).map(({ symbol, label, side, confidence, verified }) => ({ symbol, label, side, confidence, verified }));
    if (ranked.length) {
      const b = top[0];
      state = { ...state, running: false, found: true, best: b, top, message: `Best of ${state.done - state.failed} markets: ${b.label}`, at: Date.now() };
      return;
    }
    const unver = hits.length && aiOff ? 'The engines found setups but the AI check is not available (set GEMINI_API_KEY on the server). ' : '';
    state = { ...state, message: `${unver}No verified setup in ${state.done - state.failed} markets. Scanning again after the next candle.`, at: Date.now() };
    const ms = (tfSec - ((Date.now() / 1000) % tfSec)) * 1000 + 3000;
    const end = Date.now() + ms;
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
  }
}

export function registerScanRoutes(app: Express, port: number) {
  app.get('/api/scan/state', (_q, res) => res.json({ ...state, now: Date.now() }));
  app.post('/api/scan/stop', (_q, res) => { token++; state = { ...state, running: false }; res.json({ status: 'ok' }); });
  app.post('/api/scan/start', async (req, res) => {
    const broker = String(req.body?.broker ?? '');
    if (!BROKERS.includes(broker)) return res.json({ status: 'error', msg: 'Unknown broker' });
    const tfSec = [30, 60, 120, 180, 300].includes(Number(req.body?.tf)) ? Number(req.body.tf) : 60;
    const minPayout = Math.min(100, Math.max(0, Number(req.body?.minPayout) || 0));
    try {
      const base = `http://127.0.0.1:${port}`;
      const st: any = await (await fetch(`${base}/api/status?broker=${broker}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!st.ready) return res.json({ status: 'error', msg: st.error || 'The broker is not connected yet' });
      const assets = await (await fetch(`${base}/api/assets?broker=${broker}`, { signal: AbortSignal.timeout(20000) })).json();
      if (!Array.isArray(assets) || !assets.length) return res.json({ status: 'error', msg: 'No markets loaded yet, try again in a moment' });
      const my = ++token;
      state = { ...blank(), running: true, broker, tfSec };
      void loop(port, broker, tfSec, minPayout, assets, my).catch((e) => { if (my === token) state = { ...state, running: false, message: `Scan failed: ${(e as Error).message}` }; });
      res.json({ status: 'ok' });
    } catch (e) { res.json({ status: 'error', msg: `Could not start: ${(e as Error).message}` }); }
  });
}
