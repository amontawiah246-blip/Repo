import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Maximize2,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Volume2,
  VolumeX,
  Wallet,
  Zap,
} from "lucide-react";
import { createChart, CrosshairMode, IChartApi, UTCTimestamp } from "lightweight-charts";
import { apiFetch } from "./api";
import { fmtShort } from "./assets";

export interface AgentDef {
  id: string;
  name: string;
  codename: string;
  symbol: string;
  marketName: string;
  category: "1s" | "vol" | "crash_boom" | "jump_step";
  strategyName: string;
  specialty: string;
  badgeColor: string;
}

export const SYNTHETIC_AGENTS: AgentDef[] = [
  {
    id: "agent-100v",
    name: "Agent Titan-100V",
    codename: "TITAN",
    symbol: "1HZ100V",
    marketName: "Volatility 100 (1s) Index",
    category: "1s",
    strategyName: "Liquidity Sweep & RSI Rejection",
    specialty: "High-Frequency Volatility Breakouts",
    badgeColor: "#ef4444",
  },
  {
    id: "agent-75v",
    name: "Agent Surge-75V",
    codename: "SURGE",
    symbol: "1HZ75V",
    marketName: "Volatility 75 (1s) Index",
    category: "1s",
    strategyName: "Dynamic Momentum Channel",
    specialty: "High-Speed Trend Waves",
    badgeColor: "#f97316",
  },
  {
    id: "agent-50v",
    name: "Agent Pulse-50V",
    codename: "PULSE",
    symbol: "1HZ50V",
    marketName: "Volatility 50 (1s) Index",
    category: "1s",
    strategyName: "Multi-EMA Mean Reversion",
    specialty: "Mid-Frequency Volatility Pullbacks",
    badgeColor: "#eab308",
  },
  {
    id: "agent-25v",
    name: "Agent Apex-25V",
    codename: "APEX",
    symbol: "1HZ25V",
    marketName: "Volatility 25 (1s) Index",
    category: "1s",
    strategyName: "Support & Resistance Snipes",
    specialty: "Tight Wick Reversals",
    badgeColor: "#3b82f6",
  },
  {
    id: "agent-10v",
    name: "Agent Nova-10V",
    codename: "NOVA",
    symbol: "1HZ10V",
    marketName: "Volatility 10 (1s) Index",
    category: "1s",
    strategyName: "Micro-Structure Trend",
    specialty: "Smooth Directional Flow",
    badgeColor: "#8b5cf6",
  },
  {
    id: "agent-vol100",
    name: "Agent Omega-100",
    codename: "OMEGA",
    symbol: "R_100",
    marketName: "Volatility 100 Index",
    category: "vol",
    strategyName: "High-Impact Liquidity Boss",
    specialty: "Continuous Uncut Volatility",
    badgeColor: "#ec4899",
  },
  {
    id: "agent-vol75",
    name: "Agent Sigma-75",
    codename: "SIGMA",
    symbol: "R_75",
    marketName: "Volatility 75 Index",
    category: "vol",
    strategyName: "Break of Structure (BOS)",
    specialty: "Trend Expansion Continuations",
    badgeColor: "#06b6d4",
  },
  {
    id: "agent-vol50",
    name: "Agent Phoenix-50",
    codename: "PHOENIX",
    symbol: "R_50",
    marketName: "Volatility 50 Index",
    category: "vol",
    strategyName: "Bollinger Band Pinch & Bounce",
    specialty: "Balanced Mean Reversion",
    badgeColor: "#10b981",
  },
  {
    id: "agent-vol25",
    name: "Agent Viper-25",
    codename: "VIPER",
    symbol: "R_25",
    marketName: "Volatility 25 Index",
    category: "vol",
    strategyName: "Fair Value Gap Sniping",
    specialty: "Precision Range Traps",
    badgeColor: "#14b8a6",
  },
  {
    id: "agent-vol10",
    name: "Agent Zeta-10",
    codename: "ZETA",
    symbol: "R_10",
    marketName: "Volatility 10 Index",
    category: "vol",
    strategyName: "EMA 9/21 Trend Ribbon",
    specialty: "Low-Noise Stable Trends",
    badgeColor: "#6366f1",
  },
  {
    id: "agent-crash1000",
    name: "Agent Crash-1000",
    codename: "CRASH-1K",
    symbol: "CRASH1000",
    marketName: "Crash 1000 Index",
    category: "crash_boom",
    strategyName: "Post-Crash Rebound Scanner",
    specialty: "Sudden Drop Recovery Scalps",
    badgeColor: "#ef4444",
  },
  {
    id: "agent-crash500",
    name: "Agent Crash-500",
    codename: "CRASH-500",
    symbol: "CRASH500",
    marketName: "Crash 500 Index",
    category: "crash_boom",
    strategyName: "Frequent Drop Counter-Attack",
    specialty: "Quick Drop Dip Exploits",
    badgeColor: "#f43f5e",
  },
  {
    id: "agent-boom1000",
    name: "Agent Boom-1000",
    codename: "BOOM-1K",
    symbol: "BOOM1000",
    marketName: "Boom 1000 Index",
    category: "crash_boom",
    strategyName: "Explosion Continuation Engine",
    specialty: "Green Spike Surges",
    badgeColor: "#22c55e",
  },
  {
    id: "agent-boom500",
    name: "Agent Boom-500",
    codename: "BOOM-500",
    symbol: "BOOM500",
    marketName: "Boom 500 Index",
    category: "crash_boom",
    strategyName: "Accumulation Base Catcher",
    specialty: "Upward Spike Reversals",
    badgeColor: "#10b981",
  },
  {
    id: "agent-step",
    name: "Agent Step-100",
    codename: "STEP-100",
    symbol: "stpRNG",
    marketName: "Step Index 100",
    category: "jump_step",
    strategyName: "Equal Step Distance Matrix",
    specialty: "Fixed Step Size Scalping",
    badgeColor: "#38bdf8",
  },
  {
    id: "agent-jump100",
    name: "Agent Jump-100",
    codename: "JUMP-100",
    symbol: "JD100",
    marketName: "Jump 100 Index",
    category: "jump_step",
    strategyName: "Gap Jump Volatility Tracker",
    specialty: "Sudden Gap Flow Continuity",
    badgeColor: "#a855f7",
  },
];

export interface MiniCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AgentLiveState {
  symbol: string;
  price: number;
  changePct: number;
  high: number;
  low: number;
  candles: MiniCandle[];
  side: "buy" | "sell" | "neutral";
  confidence: number;
  signalName: string;
  sweepReason: string;
  rsi: number;
  trend: "Bullish" | "Bearish" | "Consolidating";
  lastTrade?: {
    id: string;
    side: "buy" | "sell";
    stake: number;
    time: number;
    status: "pending" | "won" | "lost" | "draw";
    profit?: number | null;
  };
}

// Lightweight-charts mini-chart component with dynamic WebSocket tick streaming
function AgentMiniChart({
  wsBase,
  symbol,
  tf,
  onPriceUpdate,
}: {
  wsBase: string;
  symbol: string;
  tf: number;
  onPriceUpdate?: (price: number, changePct: number, high: number, low: number, isUp: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart: IChartApi = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "#050814" }, textColor: "#64748b", fontSize: 10 },
      grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.03)" } },
      crosshair: { mode: CrosshairMode.Hidden },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: tf < 60 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });

    let ws: WebSocket | null = null;
    let closed = false;
    let firstOpen = 0;
    let highP = 0;
    let lowP = Infinity;

    const openStream = () => {
      try {
        ws = new WebSocket(`${wsBase}/ws?broker=deriv&asset=${encodeURIComponent(symbol)}&tf=${tf}`);

        ws.onmessage = (e) => {
          if (closed) return;
          try {
            const m = JSON.parse(e.data);
            if (m.type === "history" && Array.isArray(m.candles) && m.candles.length) {
              const formatted = m.candles.map((c: any) => {
                if (c.high > highP) highP = c.high;
                if (c.low < lowP) lowP = c.low;
                return {
                  time: c.time as UTCTimestamp,
                  open: c.open,
                  high: c.high,
                  low: c.low,
                  close: c.close,
                };
              });
              series.setData(formatted);
              const last = formatted[formatted.length - 1];
              firstOpen = formatted[0].open;
              if (last && onPriceUpdate) {
                const pct = firstOpen ? ((last.close - firstOpen) / firstOpen) * 100 : 0;
                onPriceUpdate(last.close, pct, highP, lowP === Infinity ? last.low : lowP, last.close >= last.open);
              }
            } else if (m.type === "tick" && m.candle) {
              const c = m.candle;
              if (c.high > highP) highP = c.high;
              if (c.low < lowP) lowP = c.low;
              series.update({
                time: c.time as UTCTimestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
              });
              if (onPriceUpdate) {
                const pct = firstOpen ? ((c.close - firstOpen) / firstOpen) * 100 : 0;
                onPriceUpdate(c.close, pct, highP, lowP, c.close >= c.open);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        };

        ws.onerror = () => {
          /* handled silently */
        };
      } catch {
        /* handled silently */
      }
    };

    openStream();

    return () => {
      closed = true;
      if (ws) ws.close();
      chart.remove();
    };
  }, [wsBase, symbol, tf, onPriceUpdate]);

  return (
    <div className="relative w-full h-[140px] rounded-xl bg-[#050814] border border-[#141d33] overflow-hidden my-2.5">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// Individual Agent Card with clean real-time WebSocket chart and trade controls
function AgentCard({
  agent,
  globalTf,
  wsBase,
  isBusy,
  lastTrade,
  onOpenChart,
  onPlaceTrade,
}: {
  agent: AgentDef;
  globalTf: number;
  wsBase: string;
  isBusy: boolean;
  lastTrade?: AgentLiveState["lastTrade"];
  onOpenChart: (symbol: string) => void;
  onPlaceTrade: (agent: AgentDef, side: "buy" | "sell") => void;
}) {
  const [priceInfo, setPriceInfo] = useState({
    price: 0,
    changePct: 0,
    high: 0,
    low: 0,
    isUp: true,
  });

  const handlePriceUpdate = useCallback((price: number, changePct: number, high: number, low: number, isUp: boolean) => {
    setPriceInfo({ price, changePct, high, low, isUp });
  }, []);

  const isBuy = priceInfo.isUp;
  const isSell = !priceInfo.isUp && priceInfo.price > 0;

  return (
    <div className="relative bg-[#0c1324] border border-[#1a2744] hover:border-[#273d6b] rounded-2xl p-3.5 shadow-lg transition-all flex flex-col justify-between overflow-hidden">
      {/* Agent Card Header */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs text-white shadow-sm shrink-0"
              style={{ backgroundColor: agent.badgeColor }}
            >
              {agent.codename.slice(0, 2)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-bold text-xs text-white truncate">{agent.name}</h3>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              </div>
              <span className="text-[10px] text-slate-400 font-mono block truncate">
                {agent.symbol} · {agent.marketName}
              </span>
            </div>
          </div>

          <button
            onClick={() => onOpenChart(agent.symbol)}
            className="p-1 text-slate-400 hover:text-white rounded-md hover:bg-slate-800 transition shrink-0"
            title="Open full interactive chart"
          >
            <Maximize2 size={14} />
          </button>
        </div>

        {/* Price and 24h change */}
        <div className="flex items-baseline justify-between mt-2.5 px-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-bold font-mono text-white tracking-tight">
              {priceInfo.price > 0 ? priceInfo.price.toFixed(priceInfo.price < 10 ? 4 : 2) : "---"}
            </span>
            <span
              className={`text-[10px] font-mono font-semibold flex items-center ${
                priceInfo.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {priceInfo.changePct >= 0 ? (
                <TrendingUp size={11} className="mr-0.5" />
              ) : (
                <TrendingDown size={11} className="mr-0.5" />
              )}
              {priceInfo.changePct >= 0 ? "+" : ""}
              {priceInfo.changePct.toFixed(2)}%
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[9px] font-mono text-slate-400">
            <span>L: {priceInfo.low > 0 && priceInfo.low !== Infinity ? priceInfo.low.toFixed(priceInfo.low < 10 ? 2 : 1) : "-"}</span>
            <span>H: {priceInfo.high > 0 ? priceInfo.high.toFixed(priceInfo.high < 10 ? 2 : 1) : "-"}</span>
          </div>
        </div>

        {/* Lightweight Charts Real-Time Streaming Canvas */}
        <AgentMiniChart
          wsBase={wsBase}
          symbol={agent.symbol}
          tf={globalTf}
          onPriceUpdate={handlePriceUpdate}
        />

        {/* Pure Price Action State Strip */}
        <div className="flex items-center justify-between px-2 py-1.5 bg-[#080d19] border border-[#131e36] rounded-lg text-[10px] font-mono">
          <span className="text-slate-400">Live Flow:</span>
          <span className={`font-bold ${isBuy ? "text-emerald-400" : isSell ? "text-rose-400" : "text-slate-300"}`}>
            {isBuy ? "Upward Flow" : isSell ? "Downward Flow" : "Ranging"}
          </span>
        </div>
      </div>

      {/* Card Bottom: Manual Trade Action & Status */}
      <div className="mt-3 pt-2.5 border-t border-[#15223c]">
        {/* Active trade result banner if active */}
        {lastTrade && (
          <div
            className={`text-[10px] font-mono px-2 py-1 rounded-md mb-2 flex items-center justify-between ${
              lastTrade.status === "won"
                ? "bg-emerald-950/60 border border-emerald-500/40 text-emerald-300"
                : lastTrade.status === "lost"
                ? "bg-rose-950/60 border border-rose-500/40 text-rose-300"
                : "bg-blue-950/60 border border-blue-500/40 text-blue-300 animate-pulse"
            }`}
          >
            <span>
              Trade #{lastTrade.id.slice(-5)} ({lastTrade.side.toUpperCase()})
            </span>
            <span>
              {lastTrade.status === "pending"
                ? "In Progress…"
                : lastTrade.status === "won"
                ? `Won +$${(lastTrade.profit ?? 0).toFixed(2)}`
                : "Loss"}
            </span>
          </div>
        )}

        {/* Manual Trade Execution Buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onPlaceTrade(agent, "buy")}
            disabled={isBusy}
            className="flex items-center justify-center gap-1.5 py-2 px-3 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 active:scale-95 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer"
          >
            <ArrowUpRight size={15} strokeWidth={2.5} />
            <span>{isBusy ? "Placing…" : "RISE"}</span>
          </button>

          <button
            onClick={() => onPlaceTrade(agent, "sell")}
            disabled={isBusy}
            className="flex items-center justify-center gap-1.5 py-2 px-3 bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 active:scale-95 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer"
          >
            <ArrowDownRight size={15} strokeWidth={2.5} />
            <span>{isBusy ? "Placing…" : "FALL"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  http: string;
  wsBase: string;
  onOpenChart: (symbol: string) => void;
  onToast: (msg: string) => void;
  activeBalance: number | null;
  isDemo: boolean;
  onSwitchAccount: (demo: boolean) => void;
}

export default function SignalPackageAgents({
  http,
  wsBase,
  onOpenChart,
  onToast,
  activeBalance,
  isDemo,
  onSwitchAccount,
}: Props) {
  // Global Timeframe for ALL agents
  const [globalTf, setGlobalTf] = useState<number>(60);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [stake, setStake] = useState<number>(10);
  const [expirySec, setExpirySec] = useState<number>(60);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // Live state per agent symbol
  const [agentStates, setAgentStates] = useState<Record<string, AgentLiveState>>({});
  const [tradingBusy, setTradingBusy] = useState<Record<string, boolean>>({});

  const beepSound = (up: boolean) => {
    if (!soundEnabled) return;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = up ? 880 : 520;
      g.gain.value = 0.05;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.15);
      setTimeout(() => ctx.close(), 300);
    } catch {
      /* audio blocked */
    }
  };

  // Helper to compute synthetic indicators from candles
  const evaluateAgent = (cs: MiniCandle[]): Partial<AgentLiveState> => {
    if (!cs || cs.length < 5) {
      return {
        side: "neutral",
        confidence: 50,
        signalName: "Scanning Deriv tick flow…",
        sweepReason: "Building candle structure",
        rsi: 50,
        trend: "Consolidating",
      };
    }

    const n = cs.length;
    const closes = cs.map((c) => c.close);
    const last = cs[n - 1];

    // Simple RSI estimate
    let gains = 0, losses = 0;
    const rsiPeriod = Math.min(14, n - 1);
    for (let i = n - rsiPeriod; i < n; i++) {
      const diff = cs[i].close - cs[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / (losses || 1);
    const rsi = Math.round(100 - 100 / (1 + rs));

    // Simple EMA trend
    const emaShort = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const emaLong = closes.slice(-15).reduce((a, b) => a + b, 0) / Math.min(15, closes.length);
    const isBull = emaShort > emaLong;

    // Wick sweep test
    const range = Math.max(last.high - last.low, 0.00001);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const isLowerRejection = lowerWick / range > 0.45;
    const isUpperRejection = upperWick / range > 0.45;

    let side: "buy" | "sell" | "neutral" = "neutral";
    let conf = 50;
    let signalName = "Scanning";
    let sweepReason = "Normal range";

    if (isLowerRejection || (rsi < 36 && last.close > last.open)) {
      side = "buy";
      conf = Math.min(94, 65 + Math.round((40 - Math.min(40, rsi)) * 0.6) + (isBull ? 8 : 0));
      signalName = "STRONG RISE SETUP";
      sweepReason = isLowerRejection ? "Liquidity sweep below lows with wick rejection" : "Oversold RSI rebound confirmed";
    } else if (isUpperRejection || (rsi > 64 && last.close < last.open)) {
      side = "sell";
      conf = Math.min(94, 65 + Math.round((Math.max(60, rsi) - 60) * 0.6) + (!isBull ? 8 : 0));
      signalName = "STRONG FALL SETUP";
      sweepReason = isUpperRejection ? "Liquidity sweep above highs with wick rejection" : "Overbought RSI exhaustion confirmed";
    } else if (isBull) {
      side = "buy";
      conf = 68;
      signalName = "TRENDING RISE";
      sweepReason = "EMA ribbon expansion & buyer volume";
    } else {
      side = "sell";
      conf = 67;
      signalName = "TRENDING FALL";
      sweepReason = "EMA ribbon downward slope & seller volume";
    }

    const first = cs[0].open;
    const cur = last.close;
    const changePct = first ? ((cur - first) / first) * 100 : 0;
    const high = Math.max(...cs.map((c) => c.high));
    const low = Math.min(...cs.map((c) => c.low));

    return {
      price: cur,
      changePct,
      high,
      low,
      side,
      confidence: conf,
      signalName,
      sweepReason,
      rsi,
      trend: isBull ? "Bullish" : "Bearish",
    };
  };

  // Fetch candles for all synthetic agents from the server
  const loadAllAgents = useCallback(async () => {
    setRefreshing(true);
    try {
      const symbols = SYNTHETIC_AGENTS.map((a) => a.symbol);
      const updates: Record<string, AgentLiveState> = {};

      await Promise.all(
        symbols.map(async (sym) => {
          try {
            const res = await apiFetch(`${http}/api/deriv/synthetic-candles?symbol=${encodeURIComponent(sym)}&tf=${globalTf}&count=35`);
            if (res.ok) {
              const data = await res.json();
              const cs: MiniCandle[] = Array.isArray(data.candles) ? data.candles : [];
              const evalRes = evaluateAgent(cs);
              updates[sym] = {
                symbol: sym,
                candles: cs,
                price: evalRes.price ?? 0,
                changePct: evalRes.changePct ?? 0,
                high: evalRes.high ?? 0,
                low: evalRes.low ?? 0,
                side: evalRes.side ?? "neutral",
                confidence: evalRes.confidence ?? 50,
                signalName: evalRes.signalName ?? "Scanning",
                sweepReason: evalRes.sweepReason ?? "",
                rsi: evalRes.rsi ?? 50,
                trend: evalRes.trend ?? "Consolidating",
              };
            }
          } catch {
            /* ignore individual errors */
          }
        })
      );

      setAgentStates((prev) => ({
        ...prev,
        ...updates,
      }));
    } finally {
      setRefreshing(false);
    }
  }, [http, globalTf]);

  // Initial load and periodic refresh
  useEffect(() => {
    loadAllAgents();
    const interval = setInterval(loadAllAgents, Math.max(4000, globalTf * 1000));
    return () => clearInterval(interval);
  }, [loadAllAgents, globalTf]);

  // Execute manual trade for a specific agent
  const placeManualTrade = async (agent: AgentDef, side: "buy" | "sell") => {
    if (tradingBusy[agent.symbol]) return;

    setTradingBusy((prev) => ({ ...prev, [agent.symbol]: true }));
    beepSound(side === "buy");
    onToast(`Executing manual ${side === "buy" ? "RISE" : "FALL"} on ${agent.name} ($${stake}, ${fmtShort(expirySec)})…`);

    try {
      const res = await apiFetch(`${http}/api/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker: "deriv",
          asset: agent.symbol,
          side,
          amount: stake,
          seconds: expirySec,
        }),
      });

      const data = await res.json();
      if (data.status === "ok") {
        const tradeId = data.id;
        onToast(`Trade placed: Contract #${tradeId}. Watching outcome…`);

        setAgentStates((prev) => ({
          ...prev,
          [agent.symbol]: {
            ...prev[agent.symbol],
            lastTrade: {
              id: tradeId,
              side,
              stake,
              time: Date.now(),
              status: "pending",
            },
          },
        }));

        const poll = async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, Math.min(3000, (expirySec * 1000) / 4)));
            try {
              const rRes = await apiFetch(`${http}/api/trade-result?broker=deriv&id=${tradeId}&seconds=${expirySec}`);
              if (rRes.ok) {
                const rData = await rRes.json();
                if (rData.status === "ok" && rData.result) {
                  const won = rData.result === "win";
                  const profit = rData.profit;
                  beepSound(won);
                  onToast(`${agent.name} trade settled: ${won ? "WON" : "LOST"} (${profit != null ? `${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}` : ""})!`);
                  setAgentStates((p) => ({
                    ...p,
                    [agent.symbol]: {
                      ...p[agent.symbol],
                      lastTrade: {
                        ...(p[agent.symbol]?.lastTrade ?? { id: tradeId, side, stake, time: Date.now() }),
                        status: won ? "won" : "lost",
                        profit,
                      },
                    },
                  }));
                  return;
                }
              }
            } catch {
              /* ignore interim errors */
            }
          }
        };
        void poll();
      } else {
        onToast(`Order rejected: ${data.msg || "Check balance or limits"}`);
      }
    } catch (e) {
      onToast(`Network error placing trade: ${String(e)}`);
    } finally {
      setTradingBusy((prev) => ({ ...prev, [agent.symbol]: false }));
    }
  };

  // Filtered agents
  const visibleAgents = useMemo(() => {
    return SYNTHETIC_AGENTS.filter((a) => {
      if (activeCategory !== "all" && a.category !== activeCategory) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        a.name.toLowerCase().includes(q) ||
        a.symbol.toLowerCase().includes(q) ||
        a.marketName.toLowerCase().includes(q) ||
        a.codename.toLowerCase().includes(q)
      );
    });
  }, [activeCategory, searchQuery]);

  return (
    <div className="w-full min-h-screen bg-[#070b14] text-slate-100 flex flex-col pb-24 overflow-y-auto">
      {/* Top Header Bar */}
      <div className="sticky top-0 z-30 bg-[#0a1020]/95 backdrop-blur-md border-b border-[#1c2944] px-4 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500/20 via-blue-500/20 to-purple-500/30 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-lg shadow-blue-500/10">
              <Zap size={22} className="text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
                  SIGNAL PACKAGE <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono">DERIV MULTI-ENGINE</span>
                </h1>
              </div>
              <p className="text-xs text-slate-400">
                Independent AI agents monitoring Deriv synthetic volatility & spike markets live
              </p>
            </div>
          </div>

          {/* Account status & Demo/Real switch */}
          <div className="flex items-center gap-2 bg-[#0e1628] border border-[#1e2e4f] rounded-xl px-3 py-1.5">
            <Wallet size={16} className="text-blue-400" />
            <div className="flex flex-col text-right">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Deriv Balance</span>
              <span className="text-sm font-bold font-mono text-emerald-400">
                {activeBalance != null ? `$${activeBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Connecting…"}
              </span>
            </div>
            <button
              onClick={() => onSwitchAccount(!isDemo)}
              className={`ml-2 text-[10px] font-bold px-2.5 py-1 rounded-md transition-all ${
                isDemo
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                  : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
              }`}
            >
              {isDemo ? "DEMO" : "REAL"}
            </button>
            <button
              onClick={loadAllAgents}
              disabled={refreshing}
              className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-slate-800 transition"
              title="Refresh all agent data"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin text-blue-400" : ""} />
            </button>
          </div>
        </div>

        {/* Global Controls & Timeframe Selector */}
        <div className="max-w-7xl mx-auto mt-3 pt-3 border-t border-[#18243e] flex flex-wrap items-center justify-between gap-3">
          {/* Global Timeframe buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 flex items-center gap-1 mr-1">
              <Clock size={13} /> Timeframe:
            </span>
            {[
              { label: "5s", sec: 5 },
              { label: "15s", sec: 15 },
              { label: "30s", sec: 30 },
              { label: "1m", sec: 60 },
              { label: "2m", sec: 120 },
              { label: "3m", sec: 180 },
              { label: "4m", sec: 240 },
              { label: "5m", sec: 300 },
              { label: "10m", sec: 600 },
              { label: "15m", sec: 900 },
              { label: "30m", sec: 1800 },
              { label: "1h", sec: 3600 },
            ].map((t) => (
              <button
                key={t.sec}
                onClick={() => setGlobalTf(t.sec)}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  globalTf === t.sec
                    ? "bg-blue-600 text-white font-bold shadow-md shadow-blue-500/25 border border-blue-400/50"
                    : "bg-[#111c33] text-slate-300 hover:bg-[#192747] border border-[#1e2f54]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Stake & Expiry manual trading config */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-[#101b33] border border-[#1d2f54] rounded-lg px-2 py-1 text-xs">
              <span className="text-slate-400 font-medium">Stake:</span>
              <span className="font-bold font-mono text-white">$</span>
              <input
                type="number"
                min="1"
                max="10000"
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value)))}
                className="w-14 bg-transparent font-mono font-bold text-white text-center focus:outline-none"
              />
              <div className="flex gap-1 ml-1">
                {[5, 10, 25, 50].map((s) => (
                  <button
                    key={s}
                    onClick={() => setStake(s)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      stake === s ? "bg-blue-600 text-white font-bold" : "bg-[#182644] text-slate-300 hover:bg-[#22355c]"
                    }`}
                  >
                    ${s}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1 bg-[#101b33] border border-[#1d2f54] rounded-lg px-2 py-1 text-xs">
              <span className="text-slate-400 font-medium">Expiry:</span>
              <select
                value={expirySec}
                onChange={(e) => setExpirySec(Number(e.target.value))}
                className="bg-transparent font-mono font-bold text-white focus:outline-none cursor-pointer"
              >
                <option value={15} className="bg-[#0e1628]">15s</option>
                <option value={30} className="bg-[#0e1628]">30s</option>
                <option value={60} className="bg-[#0e1628]">1m (60s)</option>
                <option value={120} className="bg-[#0e1628]">2m</option>
                <option value={300} className="bg-[#0e1628]">5m</option>
              </select>
            </div>

            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-1.5 rounded-lg border transition ${
                soundEnabled
                  ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                  : "bg-slate-800 border-slate-700 text-slate-500"
              }`}
              title={soundEnabled ? "Mute trade sounds" : "Enable trade sounds"}
            >
              {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
          </div>
        </div>

        {/* Category Filters and Search */}
        <div className="max-w-7xl mx-auto mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 text-xs">
            {[
              { id: "all", label: `All Agents (${SYNTHETIC_AGENTS.length})` },
              { id: "1s", label: "1-Second Volatility" },
              { id: "vol", label: "Standard Volatility" },
              { id: "crash_boom", label: "Crash & Boom" },
              { id: "jump_step", label: "Jump & Step" },
            ].map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1 rounded-full whitespace-nowrap transition-all ${
                  activeCategory === cat.id
                    ? "bg-slate-200 text-slate-900 font-bold"
                    : "bg-[#101b33] text-slate-400 hover:text-slate-200 border border-[#1a2b4d]"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="relative min-w-[200px] flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search synthetic index or agent…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#101a30] border border-[#1d2e50] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Main Multi-Agent Grid */}
      <div className="max-w-7xl mx-auto px-4 py-4 w-full">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              globalTf={globalTf}
              wsBase={wsBase}
              isBusy={!!tradingBusy[agent.symbol]}
              lastTrade={agentStates[agent.symbol]?.lastTrade}
              onOpenChart={onOpenChart}
              onPlaceTrade={placeManualTrade}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
