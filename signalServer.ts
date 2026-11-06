// The signal pipeline:  candles -> 3 engines (sweep boss + indicators + candlestick, run in the bridge)
//                       -> AI check (Gemini reads the same candles and the engines' findings, approves or vetoes)
//                       -> final signal. The chart itself is never touched: everything here runs in the background.
import type { Express } from 'express';
import { GoogleGenAI } from '@google/genai';
import { Condition, marketCondition, setupKind } from './src/conditions';

export interface Cand { time: number; open: number; high: number; low: number; close: number }
export interface EngineResult {
  status: string; setup: boolean; side: 'BUY' | 'SELL' | null; confidence: number; agree: number; candles: number;
  sweep: { side: string; reasons: string[] } | null;
  indicators: { side: string; strategies: string[]; count: number; info?: Record<string, number> } | null;
  pattern: { side: string; patterns: string[]; counted: boolean } | null;
  reasons: string[];
}
export interface AiVerdict { status: 'approved' | 'vetoed' | 'unavailable'; adjust: number; reason: string; risks: string[] }
export interface Signal {
  setup: boolean; tradeable: boolean; side: 'buy' | 'sell' | null; confidence: number;
  status: string; reasons: string[]; engine: EngineResult; ai: AiVerdict | null; candleTime: number; tf: number;
  condition: Condition | null; setupName: string;   // the "Market condition" box
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export async function runEngines(port: number, candles: Cand[], tf: number, nowSec?: number): Promise<EngineResult> {
  const r = await fetch(`http://127.0.0.1:${port}/api/engines`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candles, tf, minInd: 1, now: nowSec }), signal: AbortSignal.timeout(20000),
  });
  const d: any = await r.json();
  if (d.status !== 'ok') throw new Error(d.msg || 'engine error');
  return { ...d, status: String(d.state ?? '') } as EngineResult;
}

export function buildPrompt(e: EngineResult, candles: Cand[], tf: number, label: string): string {
  const rows = candles.slice(-60).map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close}`).join('\n');
  return [
    `You are the final risk checker of a binary-options trading system. Three rule engines found a ${e.side} setup on ${label} (${tf}s candles).`,
    `You do NOT invent trades. You read the chart data and either APPROVE or VETO this exact setup. When in doubt, VETO.`,
    ``,
    `Engine findings (any engine may trigger; sweep + indicators agreeing is the strongest pair, a pattern backed by the others is stronger still):`,
    ...e.reasons.map((r) => `- ${r}`),
    `Engines agreeing: ${e.agree} of 3. Indicator values: ${JSON.stringify(e.indicators?.info ?? {})}`,
    ``,
    `Check on the candles below (time,open,high,low,close; oldest first; the LAST row is the signal candle, already closed):`,
    `1. Is the last candle a real wick rejection of a level (not a breakout or a drift)?`,
    `2. Does the surrounding trend and structure support a ${e.side}, or does it fight a strong move?`,
    `3. Is price entering straight into nearby opposing support/resistance, or after an exhausted move?`,
    `4. Is the market choppy or erratic (many overlapping candles, huge random wicks)?`,
    ``,
    rows,
    ``,
    `Reply with JSON only: {"verdict":"approve"|"veto","confidenceAdjust":integer from -15 to 5,"reason":"max 200 characters","risks":["short risk", ...]}`,
  ].join('\n');
}

export function parseAi(text: string): AiVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in the AI reply');
  const j = JSON.parse(m[0]);
  const v = String(j.verdict ?? '').toLowerCase();
  if (v !== 'approve' && v !== 'veto') throw new Error('bad verdict');
  return {
    status: v === 'approve' ? 'approved' : 'vetoed',
    adjust: clamp(Math.round(Number(j.confidenceAdjust) || 0), -15, 5),
    reason: String(j.reason ?? '').slice(0, 240),
    risks: Array.isArray(j.risks) ? j.risks.slice(0, 4).map((x: unknown) => String(x).slice(0, 80)) : [],
  };
}

export type AiCaller = (prompt: string) => Promise<string>;

export function geminiCaller(): AiCaller | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  const ai = new GoogleGenAI({ apiKey: key });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  return async (prompt) => {
    const call = ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: 'application/json', temperature: 0.1 } });
    const out: any = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('AI timed out')), 25000))]);
    return String(out.text ?? '');
  };
}

export function merge(engine: EngineResult, ai: AiVerdict | null, candleTime: number, tf: number): Signal {
  const side: 'buy' | 'sell' | null = engine.side === 'BUY' ? 'buy' : engine.side === 'SELL' ? 'sell' : null;
  const base = { engine, ai, candleTime, tf, side, condition: null as Condition | null, setupName: 'None' };
  if (!engine.setup) return { ...base, side: null, setup: false, tradeable: false, confidence: 0, status: engine.status, reasons: engine.reasons };
  if (!ai || ai.status === 'unavailable') {
    return { ...base, setup: true, tradeable: false, confidence: engine.confidence, status: 'Engines agree, but the AI check is not available, so this is not verified', reasons: engine.reasons };
  }
  if (ai.status === 'vetoed') {
    return { ...base, side: null, setup: false, tradeable: false, confidence: 0, status: `AI vetoed: ${ai.reason}`, reasons: [...engine.reasons, `AI veto: ${ai.reason}`] };
  }
  return {
    ...base, setup: true, tradeable: true, confidence: clamp(engine.confidence + ai.adjust, 0, 95),
    status: 'Verified by the AI', reasons: [...engine.reasons, `AI approved: ${ai.reason}`],
  };
}

const cache = new Map<string, { at: number; ai: AiVerdict }>();

export interface SignalDeps { engines(candles: Cand[], tf: number, nowSec?: number): Promise<EngineResult>; ai: AiCaller | null; now?: () => number }

/** nowSec = the broker's clock in seconds (from a live tick). Candle times follow the broker's clock, so closed/forming is decided with it. */
async function getSignalCore(d: SignalDeps, candles: Cand[], tf: number, label: string, key: string, nowSec?: number): Promise<Signal> {
  const now = nowSec != null ? nowSec * 1000 : d.now ? d.now() : Date.now();
  const closed = candles.length && candles[candles.length - 1].time >= Math.floor(now / 1000 / tf) * tf ? candles.slice(0, -1) : candles;
  const candleTime = closed.length ? closed[closed.length - 1].time : 0;
  const engine = await d.engines(candles, tf, nowSec);
  if (!engine.setup) return merge(engine, null, candleTime, tf);
  const ck = `${key}|${tf}|${candleTime}|${engine.side}`;
  const hit = cache.get(ck);
  if (hit && now - hit.at < 180000) return merge(engine, hit.ai, candleTime, tf);
  let ai: AiVerdict;
  if (!d.ai) ai = { status: 'unavailable', adjust: 0, reason: 'No GEMINI_API_KEY set on the server', risks: [] };
  else {
    try { ai = parseAi(await d.ai(buildPrompt(engine, closed, tf, label))); }
    catch (e) { ai = { status: 'unavailable', adjust: 0, reason: `AI check failed: ${(e as Error).message}`, risks: [] }; }
  }
  if (ai.status !== 'unavailable') { cache.set(ck, { at: now, ai }); if (cache.size > 200) cache.delete(cache.keys().next().value as string); }
  return merge(engine, ai, candleTime, tf);
}

export async function getSignal(d: SignalDeps, candles: Cand[], tf: number, label: string, key: string, nowSec?: number): Promise<Signal> {
  const sig = await getSignalCore(d, candles, tf, label, key, nowSec);
  const now = nowSec != null ? nowSec : Date.now() / 1000;
  const closed = candles.length && candles[candles.length - 1].time >= Math.floor(now / tf) * tf ? candles.slice(0, -1) : candles;
  const cond = marketCondition(closed);
  sig.condition = cond;
  sig.setupName = setupKind(sig.setup ? sig.side : null, cond, (sig.engine as EngineResult & { engines?: string[] }).engines ?? []);
  if (cond && sig.setup && sig.engine.sweep) cond.priceAction = sig.engine.sweep.side === 'BUY' ? 'Sweep below lows' : 'Sweep above highs';
  return sig;
}

let caller: AiCaller | null | undefined;
/** For tests: use this AI instead of Gemini. */
export function setAiCaller(c: AiCaller | null) { caller = c; }
export function liveDeps(port: number): SignalDeps {
  if (caller === undefined) caller = geminiCaller();
  return { engines: (c, tf, n) => runEngines(port, c, tf, n), ai: caller };
}

export function registerSignalRoutes(app: Express, port: number) {
  app.get('/api/signal/status', (_req, res) => {
    if (caller === undefined) caller = geminiCaller();
    res.json({ ai: !!caller, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
  });
  app.post('/api/signal', async (req, res) => {
    try {
      const candles: Cand[] = Array.isArray(req.body?.candles) ? req.body.candles.slice(-600) : [];
      const tf = [30, 60, 120, 180, 300].includes(Number(req.body?.tf)) ? Number(req.body.tf) : 60;
      const label = String(req.body?.label ?? req.body?.symbol ?? 'this market').slice(0, 40);
      const nowSec = Number.isFinite(Number(req.body?.now)) && Number(req.body?.now) > 1e9 ? Number(req.body.now) : undefined;
      const s = await getSignal(liveDeps(port), candles, tf, label, String(req.body?.symbol ?? label), nowSec);
      res.json({ status: 'ok', signal: s });
    } catch (e) {
      res.json({ status: 'error', msg: (e as Error).message });
    }
  });
}
