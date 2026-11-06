// Server-side AI Trading: the same engine as the Pro mode screen (src/autopilot.ts), but it runs here,
// so it keeps trading when the phone is locked or the app is closed. The app only starts, stops and watches it.
import type { Express, Request, Response, NextFunction } from 'express';
import { WebSocket } from 'ws';
import { Autopilot, AutoConfig, DEFAULT_CFG, Deps, Watch } from './src/autopilot';
import { splitName, Asset } from './src/assets';
import type { Candle } from './src/analysis';
import { getSignal, liveDeps } from './signalServer';

const AUTO_BROKERS = ['pocket', 'quotex', 'iqoption', 'deriv'];   // every broker the bridge can place orders on
const DERIV_TRADABLE = ['risefall'];   // Deriv trade types the bridge can place so far

interface Run { ap: Autopilot; broker: string; cfg: AutoConfig }
let run: Run | null = null;

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
export function cleanCfg(raw: Record<string, unknown> = {}): AutoConfig {
  const tf = Number(raw.tfSec);
  return {
    stake: num(raw.stake, DEFAULT_CFG.stake, 0.01, 100000),
    tfSec: [30, 60, 300].includes(tf) ? tf : DEFAULT_CFG.tfSec,
    minConf: num(raw.minConf, DEFAULT_CFG.minConf, 55, 95),
    maxTrades: Math.round(num(raw.maxTrades, DEFAULT_CFG.maxTrades, 1, 500)),
    maxLossStreak: Math.round(num(raw.maxLossStreak, DEFAULT_CFG.maxLossStreak, 1, 20)),
    stopLoss: num(raw.stopLoss, DEFAULT_CFG.stopLoss, 1, 1000000),
    minPayout: num(raw.minPayout, DEFAULT_CFG.minPayout, 0, 100),
    scanCount: Math.round(num(raw.scanCount, DEFAULT_CFG.scanCount, 1, 200)),
  };
}

export function makeServerDeps(port: number, broker: string, initial: Asset[]): Deps {
  const base = `http://127.0.0.1:${port}`;
  let list = initial, at = Date.now(), loading = false;
  const refresh = () => {
    if (loading || Date.now() - at < 60000) return;
    loading = true;
    fetch(`${base}/api/assets?broker=${encodeURIComponent(broker)}`).then((r) => r.json()).then((a) => {
      if (Array.isArray(a) && a.length) { list = a; at = Date.now(); }
    }).catch(() => { /* keep the old list */ }).finally(() => { loading = false; });
  };
  return {
    assets: () => {
      refresh();
      return list.map((a) => { const n = splitName(a); return { symbol: a.symbol, label: n.label + (n.otc ? ' OTC' : ''), payout: broker === 'deriv' && !((a.payout ?? 0) > 0) ? 100 : a.payout, active: a.active }; });   // Deriv prices the payout per contract, so it has no fixed percent
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // The three engines + the AI check decide. No verified setup, or a setup older than 40% of a candle, means no trade.
    analyze: async (symbol, candles, tfSec, nowSec) => {
      const label = splitName(list.find((a) => a.symbol === symbol) ?? ({ symbol } as Asset)).label;
      const clk = nowSec ?? Date.now() / 1000;
      const sig = await getSignal(liveDeps(port), candles, tfSec, label, `${broker}:${symbol}`, clk);
      if (!sig.tradeable || !sig.side) return { none: sig.setup && !sig.tradeable ? sig.status : sig.status.replace(/^AI vetoed: /, 'AI vetoed: ').slice(0, 90) };
      const age = clk - (sig.candleTime + tfSec);
      if (age > Math.max(20, tfSec * 0.5)) return { none: `setup is ${Math.round(age)}s old, too late to enter` };
      return { side: sig.side, confidence: sig.confidence, why: `${sig.setupName}${sig.condition ? ` · ${sig.condition.trend.toLowerCase()} · RSI ${sig.condition.rsi}` : ''} · ${sig.engine.agree}/3 engines (${((sig.engine as any).engines ?? []).join('+')}), AI approved` };
    },
    watch: (symbol, tfSec) => new Promise<Watch>((resolve, reject) => {
      let price: number | null = null, got = false, clock: number | null = null;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(symbol)}&tf=${tfSec}`);
      const fail = (m: string) => { if (!got) { got = true; clearTimeout(to); try { ws.close(); } catch { /* closed */ } reject(new Error(m)); } };
      const to = setTimeout(() => fail('The bridge did not answer in time'), 30000);
      ws.on('error', () => fail('Could not reach the bridge'));
      ws.on('close', () => fail('The bridge closed the connection'));
      ws.on('message', (raw) => {
        let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'history' && !got && Array.isArray(m.candles) && m.candles.length) {
          got = true; clearTimeout(to);
          const w: Watch = { candles: m.candles as Candle[], price: () => price, clock: () => clock, close: () => { try { ws.close(); } catch { /* closed */ } } };
          // wait (briefly) for a live tick: its timestamp is the broker's clock, which decides which candle is still forming
          const t0 = Date.now(); const iv = setInterval(() => { if (clock != null || Date.now() - t0 > 4000) { clearInterval(iv); resolve(w); } }, 100);
        } else if (m.type === 'tick' && typeof m.price === 'number') { price = m.price; if (typeof m.ts === 'number') clock = m.ts; }
        else if (m.type === 'error') fail(m.msg || 'Bridge error');
      });
    }),
    place: async (symbol, side, stake, seconds) => {
      try {
        const r = await fetch(`${base}/api/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, asset: symbol, side, amount: stake, seconds }), signal: AbortSignal.timeout(40000) });
        const d: any = await r.json();
        return { ok: d.status === 'ok', msg: d.msg || '', id: d.id ? String(d.id) : undefined };
      } catch { return { ok: false, msg: 'Could not reach the bridge' }; }
    },
    result: async (id, seconds) => {
      await new Promise((r) => setTimeout(r, seconds * 1000 + 500));          // let the trade run out first
      try {
        const r = await fetch(`${base}/api/trade-result?broker=${encodeURIComponent(broker)}&id=${encodeURIComponent(id)}&seconds=0`, { signal: AbortSignal.timeout(90000) });
        const d: any = await r.json();
        if (d.status !== 'ok' || !['win', 'loss', 'draw'].includes(d.result)) return null;
        return { outcome: d.result, profit: typeof d.profit === 'number' ? d.profit : null };
      } catch { return null; }
    },
  };
}

/** Optional protection: when TRADE_PIN is set, anything that can place trades needs the header x-pin. */
function pinGuard(req: Request, res: Response, next: NextFunction) {
  const pin = process.env.TRADE_PIN;
  if (!pin || req.headers['x-pin'] === pin) return next();
  res.status(401).json({ status: 'error', msg: 'PIN required' });
}

export function registerAutoRoutes(app: Express, bridgePort: number) {
  app.use(['/api/trade', '/api/auto', '/api/account'], pinGuard);

  app.get('/api/auto/state', (_req, res) => {
    res.json({ active: !!run?.ap.running, broker: run?.broker ?? '', cfg: run?.cfg ?? null, state: run?.ap.state ?? null, now: Date.now() });
  });

  app.post('/api/auto/start', async (req, res) => {
    if (run?.ap.running) return res.status(409).json({ status: 'error', msg: 'AI Trading is already running' });
    const broker = String(req.body?.broker ?? '');
    if (!AUTO_BROKERS.includes(broker)) return res.json({ status: 'error', msg: 'AI Trading does not support this broker' });
    const derivType = String(req.body?.derivType ?? req.body?.cfg?.derivType ?? 'risefall');
    if (broker === 'deriv' && !DERIV_TRADABLE.includes(derivType)) return res.json({ status: 'error', msg: 'On Deriv, AI Trading can place Rise/Fall trades only for now. Pick Rise/Fall as the trade type.' });
    const cfg = cleanCfg(req.body?.cfg);
    if (broker === 'iqoption' && cfg.tfSec === 30) cfg.tfSec = 60;   // IQ Option expiries sit on whole minutes
    try {
      const base = `http://127.0.0.1:${bridgePort}`;
      const st: any = await (await fetch(`${base}/api/status?broker=${broker}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!st.ready) return res.json({ status: 'error', msg: st.error || 'The broker is not connected yet' });
      const assets = await (await fetch(`${base}/api/assets?broker=${broker}`, { signal: AbortSignal.timeout(20000) })).json();
      if (!Array.isArray(assets) || !assets.length) return res.json({ status: 'error', msg: 'No markets loaded yet, try again in a moment' });
      const ap = new Autopilot(makeServerDeps(bridgePort, broker, assets), cfg);
      run = { ap, broker, cfg };
      console.log(`[Auto] started on ${broker}: ${JSON.stringify(cfg)}`);
      ap.start().catch((e) => ap.stop(`Engine error: ${(e as Error).message}`));
      res.json({ status: 'ok' });
    } catch (e) {
      res.json({ status: 'error', msg: `Could not start: ${(e as Error).message}` });
    }
  });

  app.post('/api/auto/stop', (_req, res) => {
    run?.ap.stop('Stopped by you');
    res.json({ status: 'ok' });
  });

  app.post('/api/auto/clear', (_req, res) => {
    if (run && !run.ap.running) run = null;
    res.json({ status: 'ok' });
  });
}
