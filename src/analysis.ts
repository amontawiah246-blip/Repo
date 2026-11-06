// Market analysis behind the Live Signal page. Pure functions: candles in, a BUY / SELL call out.
// It is an indicator-agreement model (trend, momentum, mean-reversion, candle shape, levels).
// The confidence number says how strongly the indicators agree, it is NOT a probability of winning.

export interface Candle { time: number; open: number; high: number; low: number; close: number }
export type Side = "buy" | "sell";
export interface Reason { text: string; bias: Side | "neutral" }
export type Strength = "Low" | "Medium" | "High" | "Very high";

export interface Analysis {
  side: Side;
  confidence: number;      // 51..94
  strength: Strength;
  score: number;           // -1 (sell) .. +1 (buy)
  price: number;
  reasons: Reason[];
  stats: { rsi: number; macd: number; ema9: number; ema21: number; ema50: number; bb: number; stochK: number; atr: number };
}

export const MIN_CANDLES = 35;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const last = <T,>(a: T[], n = 1) => a[a.length - n];

export function ema(v: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}

export function macd(closes: number[]) {
  const fast = ema(closes, 12), slow = ema(closes, 26);
  const line = closes.map((_, i) => fast[i] - slow[i]);
  const sig = ema(line, 9);
  const hist = line.map((x, i) => x - sig[i]);
  return { line, sig, hist };
}

export function atr(c: Candle[], period = 14): number {
  const tr = c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  const w = tr.slice(-period);
  return w.reduce((a, b) => a + b, 0) / Math.max(1, w.length);
}

export function bollingerPct(closes: number[], period = 20, mult = 2): number {
  const w = closes.slice(-period);
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
  if (sd === 0) return 0.5;
  const up = m + mult * sd, lo = m - mult * sd;
  return (last(closes) - lo) / (up - lo);
}

export function stochastic(c: Candle[], period = 14): { k: number; d: number } {
  const ks: number[] = [];
  for (let i = Math.max(period - 1, c.length - 5); i < c.length; i++) {
    const w = c.slice(i - period + 1, i + 1);
    const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
    ks.push(hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100);
  }
  const k = last(ks);
  const d3 = ks.slice(-3);
  return { k, d: d3.reduce((a, b) => a + b, 0) / d3.length };
}

/** Pivot highs / lows (two candles each side) over the recent window. */
export function levels(c: Candle[], span = 60) {
  const w = c.slice(-span);
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < w.length - 2; i++) {
    if (w[i].high >= Math.max(w[i - 1].high, w[i - 2].high, w[i + 1].high, w[i + 2].high)) highs.push(w[i].high);
    if (w[i].low <= Math.min(w[i - 1].low, w[i - 2].low, w[i + 1].low, w[i + 2].low)) lows.push(w[i].low);
  }
  return { highs, lows };
}

interface Vote { w: number; s: number; buy: string; sell: string }

export function analyze(candles: Candle[]): Analysis | null {
  const c = candles.filter((x) => [x.open, x.high, x.low, x.close].every(Number.isFinite));
  if (c.length < MIN_CANDLES) return null;
  const closes = c.map((x) => x.close);
  const price = last(closes);
  const A = Math.max(atr(c), price * 1e-7);

  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const r = rsi(closes);
  const M = macd(closes);
  const hist = last(M.hist), histPrev = last(M.hist, 2);
  const pb = bollingerPct(closes);
  const st = stochastic(c);
  const { highs, lows } = levels(c.slice(0, -1));
  const cur = last(c), prev = last(c, 2);

  const votes: Vote[] = [];

  // 1. trend: EMA stack + price side
  const eps = A * 0.02;                                   // differences smaller than this count as "equal" (flat market)
  const dir = (x: number) => (x > eps ? 1 : x < -eps ? -1 : 0);
  const up = dir(last(e9) - last(e21)) > 0, up2 = dir(last(e21) - last(e50)) > 0, above = dir(price - last(e21)) > 0;
  const trend = dir(last(e9) - last(e21)) * 0.5 + dir(last(e21) - last(e50)) * 0.3 + dir(price - last(e21)) * 0.2;
  // In a strong trend an "oversold / overbought" reading is a weak reason to fight it.
  const fade = (s: number) => (Math.sign(s) !== 0 && Math.sign(s) === -Math.sign(trend) ? s * (1 - 0.65 * Math.abs(trend)) : s);
  votes.push({
    w: 1.2, s: trend,
    buy: up && up2 ? "Trend is up: EMA 9 is above EMA 21 and EMA 50" : "Short-term EMAs are turning up, price is above EMA 21",
    sell: !up && !up2 ? "Trend is down: EMA 9 is below EMA 21 and EMA 50" : "Short-term EMAs are turning down, price is below EMA 21",
  });

  // 2. MACD histogram and whether it is strengthening
  const mom = clamp(hist / (A * 0.15), -1, 1) * 0.8 + (hist > histPrev ? 0.2 : -0.2);
  votes.push({
    w: 1.0, s: mom,
    buy: hist > 0 ? "MACD histogram is positive and building" : "MACD histogram is recovering, selling pressure is fading",
    sell: hist < 0 ? "MACD histogram is negative and building" : "MACD histogram is rolling over, buying pressure is fading",
  });

  // 3. RSI: momentum in the middle, reversal at the extremes
  let rs: number;
  if (r >= 70) rs = -(0.35 + clamp((r - 70) / 15, 0, 1) * 0.65);
  else if (r <= 30) rs = 0.35 + clamp((30 - r) / 15, 0, 1) * 0.65;
  else rs = ((r - 50) / 50) * 0.5;
  votes.push({
    w: 1.0, s: fade(rs),
    buy: r <= 30 ? `RSI ${r.toFixed(0)} is oversold, a bounce is likely` : `RSI ${r.toFixed(0)} shows bullish momentum`,
    sell: r >= 70 ? `RSI ${r.toFixed(0)} is overbought, a pullback is likely` : `RSI ${r.toFixed(0)} shows bearish momentum`,
  });

  // 4. Bollinger %B: stretched price snaps back
  const bs = pb >= 1 ? -1 : pb <= 0 ? 1 : -(pb - 0.5) * 0.6;
  votes.push({
    w: 0.8, s: fade(bs),
    buy: pb <= 0 ? "Price is below the lower Bollinger Band, stretched to the downside" : "Price sits in the lower half of the Bollinger Bands",
    sell: pb >= 1 ? "Price is above the upper Bollinger Band, stretched to the upside" : "Price sits in the upper half of the Bollinger Bands",
  });

  // 5. Stochastic crosses in the extreme zones
  let ss = (st.k - st.d) / 50;
  if (st.k < 20 && st.k > st.d) ss = 1;
  else if (st.k > 80 && st.k < st.d) ss = -1;
  else if (st.k < 20) ss = Math.max(ss, 0.3);
  else if (st.k > 80) ss = Math.min(ss, -0.3);
  votes.push({
    w: 0.7, s: fade(clamp(ss, -1, 1)),
    buy: st.k < 20 ? "Stochastic is in the oversold zone and turning up" : "Stochastic %K is above %D",
    sell: st.k > 80 ? "Stochastic is in the overbought zone and turning down" : "Stochastic %K is below %D",
  });

  // 6. candle shape
  const body = Math.abs(cur.close - cur.open), range = Math.max(cur.high - cur.low, 1e-12);
  const upW = cur.high - Math.max(cur.open, cur.close), loW = Math.min(cur.open, cur.close) - cur.low;
  const pBody = Math.abs(prev.close - prev.open);
  let cs = clamp(((cur.close - cur.open) / range) * 0.4, -0.4, 0.4);
  let csBuy = "The last candle closed bullish", csSell = "The last candle closed bearish";
  const bullEng = prev.close < prev.open && cur.close > cur.open && cur.close >= prev.open && cur.open <= prev.close && body > pBody;
  const bearEng = prev.close > prev.open && cur.close < cur.open && cur.close <= prev.open && cur.open >= prev.close && body > pBody;
  if (bullEng) { cs = 1; csBuy = "Bullish engulfing candle: buyers overpowered the last candle"; }
  else if (bearEng) { cs = -1; csSell = "Bearish engulfing candle: sellers overpowered the last candle"; }
  else if (loW >= 2 * Math.max(body, range * 0.05) && upW <= body + range * 0.1) { cs = 0.8; csBuy = "Hammer candle with a long lower wick: sellers were rejected"; }
  else if (upW >= 2 * Math.max(body, range * 0.05) && loW <= body + range * 0.1) { cs = -0.8; csSell = "Shooting-star candle with a long upper wick: buyers were rejected"; }
  votes.push({ w: 0.8, s: cs, buy: csBuy, sell: csSell });

  // 7. short momentum over the last 3 candles
  const m3 = clamp((price - closes[closes.length - 4]) / (A * 2.5), -1, 1);
  votes.push({
    w: 0.6, s: m3,
    buy: "Price has climbed over the last 3 candles",
    sell: "Price has dropped over the last 3 candles",
  });

  // 8. nearby support / resistance
  const res = highs.filter((h) => h > price).sort((a, b) => a - b)[0];
  const sup = lows.filter((l) => l < price).sort((a, b) => b - a)[0];
  let ls = 0, lsBuy = "", lsSell = "";
  if (res !== undefined && (res - price) < A * 0.6) { ls -= 0.9; lsSell = "Price is pressing into a recent resistance level"; }
  if (sup !== undefined && (price - sup) < A * 0.6) { ls += 0.9; lsBuy = "Price is sitting on a recent support level"; }
  if (ls === 0) {
    if (res !== undefined && sup !== undefined) ls = clamp(((res - price) - (price - sup)) / (res - sup), -1, 1) * 0.3;
  }
  votes.push({ w: 0.9, s: ls, buy: lsBuy || "There is more room up to resistance than down to support", sell: lsSell || "There is more room down to support than up to resistance" });

  const totalW = votes.reduce((a, v) => a + v.w, 0);
  const score = votes.reduce((a, v) => a + v.w * v.s, 0) / totalW;
  const side: Side = score >= 0 ? "buy" : "sell";
  const sign = side === "buy" ? 1 : -1;

  const decisive = votes.filter((v) => Math.abs(v.s) > 0.15);
  const agreeW = decisive.filter((v) => Math.sign(v.s) === sign).reduce((a, v) => a + v.w, 0);
  const allW = decisive.reduce((a, v) => a + v.w, 0) || 1;
  const agree = agreeW / allW;

  let conf = 50 + 40 * Math.min(1, Math.abs(score) / 0.55) + (agree - 0.6) * 14;
  const flat = A / price < 2e-5;
  if (flat) conf -= 8;
  conf = Math.round(clamp(conf, 51, 94));
  const strength: Strength = conf < 60 ? "Low" : conf < 72 ? "Medium" : conf < 84 ? "High" : "Very high";

  const text = (v: Vote, sd: Side) => (sd === "buy" ? v.buy : v.sell);
  const withMe = votes.filter((v) => Math.sign(v.s) === sign && Math.abs(v.s) >= 0.25).sort((a, b) => b.w * Math.abs(b.s) - a.w * Math.abs(a.s)).slice(0, 4);
  const reasons: Reason[] = withMe.map((v) => ({ text: text(v, side), bias: side }));
  const against = votes.filter((v) => Math.sign(v.s) === -sign && Math.abs(v.s) >= 0.45).sort((a, b) => b.w * Math.abs(b.s) - a.w * Math.abs(a.s)).slice(0, 2);
  against.forEach((v) => reasons.push({ text: `Caution: ${text(v, side === "buy" ? "sell" : "buy").replace(/^./, (m) => m.toLowerCase())}`, bias: side === "buy" ? "sell" : "buy" }));
  if (flat) reasons.push({ text: "Caution: the market is almost flat, moves may be too small to call", bias: "neutral" });
  if (reasons.length < 2) reasons.push({ text: "Indicators are mixed, so this call is a lean rather than a conviction", bias: "neutral" });
  if (conf < 60 && !flat) reasons.push({ text: "Confidence is low: consider waiting for the next candle", bias: "neutral" });

  return {
    side, confidence: conf, strength, score: Math.round(score * 1000) / 1000, price, reasons,
    stats: { rsi: r, macd: hist, ema9: last(e9), ema21: last(e21), ema50: last(e50), bb: pb, stochK: st.k, atr: A },
  };
}

export type Outcome = "win" | "loss" | "draw";
/** One expiry window: buy wins if it closed above the open, sell if below. */
export function outcomeOf(side: Side, open: number, close: number): Outcome {
  if (close === open) return "draw";
  return (close > open) === (side === "buy") ? "win" : "loss";
}
