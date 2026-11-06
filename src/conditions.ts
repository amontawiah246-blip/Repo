// Plain-language read of a market from its closed candles: what the "Market condition" box on the signal page shows.
// Pure and background-only: it never draws anything on the chart.
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Condition {
  trend: "Up" | "Down" | "Sideways";
  trendStrength: number;                       // 0-100 (how straight the last 20 candles moved)
  volatility: "Low" | "Normal" | "High";
  rsi: number;
  bbPos: number;                               // 0-100, where price sits between the Bollinger bands
  cci: number;
  ema: { state: "Rising" | "Falling" | "Flat"; text: string };
  priceAction: string;
  support: number;
  resistance: number;
  notes: string[];                             // the "Analysis" bullets
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function emaSeries(v: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = []; let e = v[0];
  for (const x of v) { e = x * k + e * (1 - k); out.push(e); }
  return out;
}
function rsi(c: number[], n = 14): number {
  if (c.length <= n) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export const MIN_BARS = 40;

export function marketCondition(bars: Bar[]): Condition | null {
  if (bars.length < MIN_BARS) return null;
  const c = bars.map((b) => b.close), n = bars.length, last = bars[n - 1];
  const tr = bars.map((b, i) => Math.max(b.high - b.low, i ? Math.abs(b.high - bars[i - 1].close) : 0, i ? Math.abs(b.low - bars[i - 1].close) : 0));
  const atr = avg(tr.slice(-14)) || 1e-9, atrLong = avg(tr.slice(-50)) || atr;

  // trend: EMA 13 vs 34 and how directly price travelled over the last 20 candles
  const e13 = emaSeries(c, 13), e34 = emaSeries(c, 34);
  const gap = e13[n - 1] - e34[n - 1];
  const emaState = Math.abs(gap) < 0.05 * atr ? "Flat" : gap > 0 ? "Rising" : "Falling";
  const w = c.slice(-21), net = Math.abs(w[w.length - 1] - w[0]);
  const path = w.slice(1).reduce((s, x, i) => s + Math.abs(x - w[i]), 0) || 1e-9;
  const strength = Math.round((net / path) * 100);
  const slope = e34[n - 1] - e34[n - 11];
  const trend = strength < 18 || Math.abs(slope) < 0.15 * atr ? "Sideways" : slope > 0 ? "Up" : "Down";

  const ratio = atr / atrLong;
  const volatility = ratio < 0.7 ? "Low" : ratio > 1.4 ? "High" : "Normal";

  const r = rsi(c);
  const w20 = c.slice(-20), m = avg(w20), sd = Math.sqrt(avg(w20.map((x) => (x - m) ** 2))) || 1e-9;
  const lo = m - 2 * sd, hi = m + 2 * sd;
  const bbPos = Math.round(Math.min(100, Math.max(0, ((last.close - lo) / (hi - lo)) * 100)));
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3), tw = tp.slice(-20), tm = avg(tw);
  const md = avg(tw.map((x) => Math.abs(x - tm))) || 1e-9;
  const cci = Math.round((tp[n - 1] - tm) / (0.015 * md));

  // price action on the newest closed candle
  const prior = bars.slice(-21, -1), pHigh = Math.max(...prior.map((b) => b.high)), pLow = Math.min(...prior.map((b) => b.low));
  let priceAction = "Normal";
  if (last.high > pHigh && last.close < pHigh) priceAction = "Sweep above highs";
  else if (last.low < pLow && last.close > pLow) priceAction = "Sweep below lows";
  else if (last.close > pHigh) priceAction = "Breakout up";
  else if (last.close < pLow) priceAction = "Breakout down";
  else {
    const body = Math.abs(last.close - last.open), rng = Math.max(last.high - last.low, 1e-12);
    if (body / rng < 0.15) priceAction = "Indecision";
  }

  const sw = bars.slice(-30), support = Math.min(...sw.map((b) => b.low)), resistance = Math.max(...sw.map((b) => b.high));

  const notes: string[] = [];
  notes.push(emaState === "Flat" ? "The averages are flat — the market is ranging." : emaState === "Rising" ? "The fast average is above the slow one — buyers lead." : "The fast average is below the slow one — sellers lead.");
  const swingLo = Math.min(...bars.slice(-11, -1).map((b) => b.low)), swingHi = Math.max(...bars.slice(-11, -1).map((b) => b.high));
  if (last.close < swingLo) notes.push("Break of structure down: price closed below the last swing low.");
  else if (last.close > swingHi) notes.push("Break of structure up: price closed above the last swing high.");
  if (priceAction === "Sweep above highs") notes.push("Liquidity sweep above a recent high: buyers were trapped and price closed back below.");
  if (priceAction === "Sweep below lows") notes.push("Liquidity sweep below a recent low: sellers were trapped and price closed back above.");
  notes.push(volatility === "Normal" ? "Candle size is normal for this market." : volatility === "High" ? "Candles are larger than usual: moves can overshoot." : "Candles are smaller than usual: moves may be slow.");
  notes.push(r >= 70 ? "RSI is overbought." : r <= 30 ? "RSI is oversold." : "RSI is balanced.");

  return { trend, trendStrength: strength, volatility, rsi: Math.round(r * 10) / 10, bbPos, cci, ema: { state: emaState, text: `${emaState} (13 ${gap >= 0 ? "above" : "below"} 34)` }, priceAction, support, resistance, notes };
}

/** Name the kind of setup from what fired and how it relates to the trend. */
export function setupKind(side: "buy" | "sell" | null, c: Condition | null, engines: string[]): string {
  if (!side || !c) return "None";
  const withTrend = (side === "buy" && c.trend === "Up") || (side === "sell" && c.trend === "Down");
  const against = (side === "buy" && c.trend === "Down") || (side === "sell" && c.trend === "Up");
  if (engines.includes("sweep")) return against ? "Liquidity sweep reversal" : withTrend ? "Sweep with the trend" : "Liquidity sweep";
  if (engines.includes("pat") && engines.length === 1) return "Candlestick pattern";
  return withTrend ? "Trend continuation" : against ? "Reversal" : "Range entry";
}
