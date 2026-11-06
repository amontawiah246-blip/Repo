import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, Bot, ChartColumn, ChevronDown, Clock, List, Settings, TrendingDown, TrendingUp, X, Zap } from "lucide-react";
import MarketPicker from "./MarketPicker";
import DerivTradeTypes from "./DerivTradeTypes";
import SignalPackageAgents from "./SignalPackageAgents";
import { Asset, BROKERS, splitName } from "./assets";
import { Analysis, Candle, Outcome, outcomeOf } from "./analysis";
import type { Condition } from "./conditions";

export const BINARY_BROKERS = ["deriv"];
const SIGNAL_TFS = [
  { label: "S15", sec: 15 },
  { label: "S30", sec: 30 },
  { label: "M1", sec: 60 },
  { label: "M2", sec: 120 },
  { label: "M3", sec: 180 },
  { label: "M4", sec: 240 },
  { label: "M5", sec: 300 },
  { label: "M10", sec: 600 },
  { label: "M15", sec: 900 },
  { label: "M30", sec: 1800 },
  { label: "H1", sec: 3600 },
];
const MTG = [{ label: "No MTG", v: 0 }, { label: "MTG 1", v: 1 }, { label: "MTG 2", v: 2 }, { label: "MTG 3", v: 3 }];
const STEPS = ["Reading recent candles", "Liquidity sweep engine", "Indicator confirmation", "Candlestick check", "AI verification"];

type Result = Outcome | "pending" | "unknown" | "skipped";
interface Entry { time: number; result: Outcome | "wait" }
interface Track { side: "buy" | "sell"; entries: Entry[]; mtg: number; tf: number; final: Result }
interface HistoryRow { id: number; ts: number; broker: string; market: string; tf: string; side: "buy" | "sell"; conf: number; result: Result; step: number }

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const p2 = (n: number) => String(n).padStart(2, "0");
const clock = (sec: number) => { const d = new Date(sec * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function beep(up: boolean) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = up ? 880 : 520; g.gain.value = 0.06;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.16);
    setTimeout(() => ctx.close(), 400);
  } catch { /* no audio */ }
}

// ---------------------------------------------------------------- hub
const CARDS = [
  { id: "pack", icon: <Zap size={20} className="text-emerald-400" />, title: "Signal package", text: "Multi-engine AI agents monitoring Deriv synthetic volatility & spike indices live with mini charts.", cta: "Open Signal package" },
  { id: "live", icon: <Activity size={20} />, title: "Live Signal", text: "Live signals for the market you pick, with results.", cta: "Open Live Signal" },
  { id: "future", icon: <Clock size={20} />, title: "Deriv Trade Types", text: "Deriv contract types and setups.", cta: "Open Trade Types" },
  { id: "chart", icon: <ChartColumn size={20} />, title: "Live Chart", text: "Live candles with indicators and manual trading dock.", cta: "Open Live Chart" },
];

function InstallBanner({ onToast }: { onToast: (m: string) => void }) {
  const [gone, setGone] = useState(() => store.get("qx-install-dismissed", false));
  const prompt = useRef<(Event & { prompt?: () => Promise<void> }) | null>(null);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); prompt.current = e as Event & { prompt?: () => Promise<void> }; };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);
  if (gone) return null;
  const install = async () => {
    if (prompt.current?.prompt) { await prompt.current.prompt(); prompt.current = null; }
    else onToast("Open your browser menu and choose Add to Home screen");
  };
  return (
    <div className="sg-install">
      <span className="sg-mark">Q</span>
      <div><b>Install the QUANTEX app</b><small>For a better and faster experience</small></div>
      <button className="sg-grad sm" onClick={install}>Install</button>
      <button className="sg-x" aria-label="Dismiss" onClick={() => { setGone(true); store.set("qx-install-dismissed", true); }}><X size={20} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- page
interface Props {
  wsBase: string;
  apiBase: string;
  broker: string;
  setBroker: (id: string) => void;
  asset: string;
  setAsset: (s: string) => void;
  assets: Asset[];
  onOpenChart: () => void;
  onToast: (m: string) => void;
  derivType: string;
  onPickDerivType: (id: string) => void;
  balance?: number | null;
  isDemo?: boolean;
  onSwitchAccount?: (demo: boolean) => void;
  initialView?: "hub" | "pack";
}


/** What the server pipeline (3 engines + AI check) said, trimmed to what the screen shows. */
interface SigInfo { agree: number; sweep: boolean; ind: number; pattern: boolean; ai: string; aiReason: string; verified: boolean; risks: string[] }
const strengthOf = (c: number): Analysis["strength"] => (c >= 80 ? "Very high" : c >= 72 ? "High" : c >= 64 ? "Medium" : "Low");

const dec = (v: number) => (v >= 100 ? 3 : v >= 10 ? 4 : 5);
function CondBox({ c, setup }: { c: Condition; setup: string }) {
  const f = (v: number) => v.toFixed(dec(v));
  return (
    <div className="sg-cond">
      <h4>Market condition</h4>
      <div className="sg-cg">
        <div><small>Trend</small><b>{c.trend === "Up" ? "Uptrend" : c.trend === "Down" ? "Downtrend" : "Sideways"}</b></div>
        <div><small>Trend strength</small><b className="sg-meter"><i style={{ width: `${c.trendStrength}%` }} /><span>{c.trendStrength}%</span></b></div>
        <div><small>Volatility</small><b>{c.volatility}</b></div>
        <div><small>RSI (14)</small><b>{c.rsi}</b></div>
        <div><small>Bollinger position</small><b>{c.bbPos}%</b></div>
        <div><small>CCI (20)</small><b>{c.cci}</b></div>
        <div><small>EMA 13 / 34</small><b>{c.ema.text}</b></div>
        <div><small>Price action</small><b>{c.priceAction}</b></div>
        <div><small>Setup</small><b>{setup}</b></div>
        <div><small>Support</small><b>{f(c.support)}</b></div>
        <div><small>Resistance</small><b>{f(c.resistance)}</b></div>
      </div>
      <h4>Analysis</h4>
      <ul className="sg-notes">{c.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </div>
  );
}

export default function SignalsPage({ wsBase, apiBase, broker, setBroker, asset, setAsset, assets, onOpenChart, onToast, derivType, onPickDerivType, balance, isDemo, onSwitchAccount, initialView }: Props) {
  const [view, setView] = useState<"hub" | "live" | "types" | "pack">(initialView ?? "hub");

  const [picker, setPicker] = useState(false);
  const [tfSec, setTfSec] = useState<number>(() => store.get("qx-sig-tf", 60));
  const [mtg, setMtg] = useState<number>(() => store.get("qx-sig-mtg", 1));
  const [auto, setAuto] = useState(false);
  const [settings, setSettings] = useState(false);
  const [sound, setSound] = useState<boolean>(() => store.get("qx-sig-sound", true));
  const [skipWeak, setSkipWeak] = useState<boolean>(() => store.get("qx-sig-skip", false));
  const [phase, setPhase] = useState<"idle" | "analyzing" | "done">("idle");
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Analysis | null>(null);
  const [sig, setSig] = useState<SigInfo | null>(null);
  const [none, setNone] = useState("");
  const [cond, setCond] = useState<Condition | null>(null);
  const [setupName, setSetupName] = useState("");
  const [shown, setShown] = useState<{ label: string; otc: boolean } | null>(null);   // the market the result is about (Auto picks it)
  const [scan, setScan] = useState<{ running: boolean; found: boolean; total: number; done: number; message: string; pass: number } | null>(null);
  const scanId = useRef(0);
  const startScanRef = useRef<() => void>(() => {});
  const runRef = useRef<(t?: { symbol: string; label: string; otc: boolean }) => Promise<void>>(async () => {});
  const [track, setTrack] = useState<Track | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [history, setHistory] = useState<HistoryRow[]>(() => store.get("qx-sig-history", []));

  const wsRef = useRef<WebSocket | null>(null);
  const runId = useRef(0);
  const clockOff = useRef(0);               // broker seconds minus this device's seconds
  const trackRef = useRef<Track | null>(null);
  const rowId = useRef(0);
  const candleMap = useRef<Record<number, { open: number; close: number }>>({});
  const latest = useRef({ sound, skipWeak, auto });
  latest.current = { sound, skipWeak, auto };

  const current = assets.find((a) => a.symbol === asset);
  const { label: marketLabel, otc } = splitName(current ?? { symbol: asset });
  const brokerName = BROKERS.find((b) => b.id === broker)?.name ?? broker;
  const binary = BINARY_BROKERS.includes(broker);
  const tfLabel = SIGNAL_TFS.find((t) => t.sec === tfSec)?.label ?? "M1";
  const busy = phase === "analyzing";

  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(id); }, []);
  useEffect(() => () => { runId.current++; wsRef.current?.close(); }, []);
  useEffect(() => { store.set("qx-sig-tf", tfSec); store.set("qx-sig-mtg", mtg); store.set("qx-sig-sound", sound); store.set("qx-sig-skip", skipWeak); }, [tfSec, mtg, sound, skipWeak]);

  const saveHistory = useCallback((fn: (h: HistoryRow[]) => HistoryRow[]) => {
    setHistory((h) => { const n = fn(h).slice(0, 60); store.set("qx-sig-history", n); return n; });
  }, []);

  const stop = useCallback(() => { runId.current++; wsRef.current?.close(); wsRef.current = null; }, []);

  const finish = useCallback((id: number, result: Result, stepNo: number, tr: Track) => {
    tr.final = result;
    trackRef.current = tr;
    setTrack({ ...tr, entries: tr.entries.map((e) => ({ ...e })) });
    saveHistory((h) => h.map((r) => (r.id === id ? { ...r, result, step: stepNo } : r)));
    if (latest.current.sound && (result === "win" || result === "loss")) beep(result === "win");
  }, [saveHistory]);

  const run = useCallback(async (target?: { symbol: string; label: string; otc: boolean }) => {
    if (!binary) { onToast("Live Signal is for binary-options brokers. Deriv comes later."); return; }
    const sym = target?.symbol ?? asset;
    if (!sym) { onToast("Choose a market first"); return; }
    const mLabel = target?.label ?? marketLabel, mOtc = target?.otc ?? otc;
    stop();
    const my = ++runId.current;
    setErr(""); setRes(null); setSig(null); setNone(""); setCond(null); setSetupName(""); setShown({ label: mLabel, otc: mOtc }); setTrack(null); setStep(0); setPhase("analyzing");
    const stepTimer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 750);
    candleMap.current = {};
    try {
      // 1. history over the same websocket the chart uses (kept open afterwards to follow the result)
      const feed = new Promise<{ ws: WebSocket; candles: Candle[] }>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(sym)}&tf=${tfSec}`);
        let got = false;
        const to = setTimeout(() => { if (!got) { ws.close(); reject(new Error("The bridge did not answer in time")); } }, 25000);
        ws.onerror = () => { if (!got) { clearTimeout(to); reject(new Error("Could not reach the bridge")); } };
        ws.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.type === "history" && !got && Array.isArray(m.candles)) { got = true; clearTimeout(to); resolve({ ws, candles: m.candles }); }
          else if (m.type === "error" && !got) { got = true; clearTimeout(to); ws.close(); reject(new Error(m.msg || "Bridge error")); }
          else if (m.type === "tick") onTick(m);
        };
      });
      const [{ ws, candles }] = await Promise.all([feed, sleep(2800)]);
      if (my !== runId.current) { ws.close(); return; }
      wsRef.current = ws;
      // 2. the server runs the three engines in the background and asks the AI to verify; nothing is drawn on the chart
      let sg: any;
      try {
        const r = await fetch(`${apiBase}/api/signal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candles, tf: tfSec, symbol: `${broker}:${sym}`, label: mLabel, now: Date.now() / 1000 + clockOff.current }) });
        const d = await r.json();
        if (d.status !== "ok") throw new Error(d.msg || "Signal service error");
        sg = d.signal;
      } catch (e) { ws.close(); throw new Error((e as Error).message || "Could not reach the signal service"); }
      if (my !== runId.current) { ws.close(); return; }
      if (!sg.setup || !sg.side) {
        ws.close(); wsRef.current = null;
        setNone(sg.status || "No high-probability setup right now"); setPhase("done");
        setCond(sg.condition ?? null);
        if (latest.current.auto) setTimeout(() => { if (my === runId.current && latest.current.auto) startScanRef.current(); }, 1500);
        return;
      }
      const a: Analysis = { side: sg.side, confidence: sg.confidence, strength: strengthOf(sg.confidence), score: sg.side === "buy" ? 1 : -1, price: candles[candles.length - 1].close,
        reasons: (sg.reasons as string[]).map((t) => ({ text: t, bias: sg.side })), stats: { rsi: 0, macd: 0, ema9: 0, ema21: 0, ema50: 0, bb: 0, stochK: 0, atr: 0 } };
      setCond(sg.condition ?? null); setSetupName(sg.setupName ?? "");
      setSig({ agree: sg.engine.agree, sweep: !!sg.engine.sweep, ind: sg.engine.indicators && sg.engine.indicators.side === sg.engine.side ? sg.engine.indicators.count : 0, pattern: !!sg.engine.pattern?.counted, ai: sg.ai?.status ?? "unavailable", aiReason: sg.ai?.reason ?? "", verified: !!sg.tradeable, risks: sg.ai?.risks ?? [] });
      const base = Math.max(candles[candles.length - 1].time, ...Object.keys(candleMap.current).map(Number));
      const t0 = base + tfSec;
      const id = Date.now() * 10 + (rowId.current++ % 10);
      const tr: Track = { side: a.side, entries: [{ time: t0, result: "wait" }], mtg, tf: tfSec, final: "pending" };
      const weak = latest.current.auto && latest.current.skipWeak && a.confidence < 60;
      setRes(a); setPhase("done");
      if (latest.current.sound) beep(a.side === "buy");
      if (weak) {
        tr.final = "skipped"; trackRef.current = tr; setTrack({ ...tr });
        ws.close(); wsRef.current = null;
        setTimeout(() => { if (my === runId.current && latest.current.auto) startScanRef.current(); }, 1500);
        return;
      }
      trackRef.current = tr; setTrack({ ...tr, entries: tr.entries.map((e) => ({ ...e })) });
      saveHistory((h) => [{ id, ts: Math.floor(Date.now() / 1000), broker: brokerName, market: mLabel + (mOtc ? " OTC" : ""), tf: tfLabel, side: a.side, conf: a.confidence, result: "pending", step: 0 }, ...h]);
      // 2. follow ticks until the entry (and any martingale steps) have closed
      const tick = (m: { ts?: number; candle?: { time: number; open: number; close: number } }) => {
        const t = trackRef.current;
        if (!t || t.final !== "pending" || my !== runId.current || !m.candle) return;
        candleMap.current[m.candle.time] = { open: m.candle.open, close: m.candle.close };
        let changed = false;
        for (let i = 0; i < t.entries.length; i++) {
          const en = t.entries[i];
          if (en.result !== "wait") continue;
          const c = candleMap.current[en.time];
          if (c && m.candle.time > en.time) {
            en.result = outcomeOf(t.side, c.open, c.close); changed = true;
            if (en.result === "loss" && i < t.mtg) t.entries.push({ time: en.time + t.tf, result: "wait" });
            else return finish(id, en.result, i, t);
          }
        }
        if (changed) { trackRef.current = t; setTrack({ ...t, entries: t.entries.map((e) => ({ ...e })) }); }
      };
      tickRef.current = tick;
      // a tick may have arrived while we were analysing
      if (Object.keys(candleMap.current).length) tick({ candle: undefined });
      const watchdog = setInterval(() => {
        const t = trackRef.current;
        if (my !== runId.current || !t || t.final !== "pending") { clearInterval(watchdog); return; }
        const lastE = t.entries[t.entries.length - 1];
        if (Date.now() / 1000 + clockOff.current > lastE.time + t.tf + 30) { clearInterval(watchdog); finish(id, "unknown", t.entries.length - 1, t); }
      }, 2000);
    } catch (e) {
      if (my === runId.current) { setErr((e as Error).message || "Signal failed"); setPhase("idle"); }
    } finally {
      clearInterval(stepTimer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binary, asset, wsBase, broker, tfSec, mtg, brokerName, marketLabel, otc, tfLabel, stop, finish, saveHistory, onToast]);

  const tickRef = useRef<((m: { ts?: number; candle?: { time: number; open: number; close: number } }) => void) | null>(null);
  function onTick(m: { ts?: number; candle?: { time: number; open: number; close: number } }) {
    if (typeof m.ts === "number") clockOff.current = m.ts - Date.now() / 1000;
    if (m.candle) candleMap.current[m.candle.time] = { open: m.candle.open, close: m.candle.close };
    tickRef.current?.(m);
  }

  // Auto: scan every market of the broker on the server, show the best verified setup, then scan again after its result.
  const startScan = useCallback(async () => {
    if (!latest.current.auto) return;
    const id = ++scanId.current;
    stop(); setErr(""); setRes(null); setSig(null); setNone(""); setCond(null); setTrack(null); setPhase("analyzing"); setScan({ running: true, found: false, total: 0, done: 0, message: "Starting…", pass: 0 });
    try {
      const r = await fetch(`${apiBase}/api/scan/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker, tf: tfSec, minPayout: 0 }) });
      const d = await r.json();
      if (d.status !== "ok") { setErr(d.msg || "Could not start the scan"); setPhase("idle"); setScan(null); setAuto(false); return; }
    } catch { setErr("Could not reach the server"); setPhase("idle"); setScan(null); setAuto(false); return; }
    for (;;) {
      await sleep(1500);
      if (id !== scanId.current || !latest.current.auto) return;
      try {
        const st = await (await fetch(`${apiBase}/api/scan/state`)).json();
        setScan({ running: st.running, found: st.found, total: st.total, done: st.done, message: st.message, pass: st.pass });
        if (st.found && st.best) {
          const a = assets.find((x) => x.symbol === st.best.symbol);
          const nm = splitName(a ?? { symbol: st.best.symbol });
          setAsset(st.best.symbol); setScan(null);
          void runRef.current({ symbol: st.best.symbol, label: nm.label, otc: nm.otc });
          return;
        }
        if (!st.running && !st.found) { setErr(st.message || "The scan stopped"); setPhase("idle"); setScan(null); setAuto(false); return; }
      } catch { /* try again */ }
    }
  }, [apiBase, broker, tfSec, assets, setAsset, stop]); // eslint-disable-line react-hooks/exhaustive-deps

  startScanRef.current = () => { void startScan(); };
  runRef.current = run;
  useEffect(() => {
    if (auto && track && (track.final === "win" || track.final === "loss" || track.final === "draw" || track.final === "unknown")) {
      const id = setTimeout(() => { if (latest.current.auto) void startScan(); }, 1800);
      return () => clearTimeout(id);
    }
  }, [auto, track?.final]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (auto && binary && phase !== "analyzing") void startScan();
    if (!auto) { scanId.current++; setScan(null); void fetch(`${apiBase}/api/scan/stop`, { method: "POST" }).catch(() => {}); }
  }, [auto]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!auto) return; if (view !== "live") setAuto(false); }, [view, auto]);

  const open = (id: string) => {
    if (id === "pack") setView("pack");
    else if (id === "live") setView("live");
    else if (id === "chart") onOpenChart();
    else if (id === "future" && broker === "deriv") setView("types");
    else if (id === "future") onToast("Future Signals is coming soon. Choose Deriv to pick a trade type.");
    else onToast(`${CARDS.find((c) => c.id === id)?.title} is coming soon`);
  };

  const serverNow = now + clockOff.current;

  // ---------------------------------------------------- exports
  const rows = history;
  const resText = (r: Result) => (r === "pending" ? "Pending" : r === "win" ? "Win" : r === "loss" ? "Loss" : r === "draw" ? "Draw" : r === "skipped" ? "Skipped" : "Unknown");
  const exportCsv = () => {
    if (!rows.length) return onToast("No signals to export yet");
    const csv = ["time_utc,broker,market,timeframe,side,confidence,result,martingale_step",
      ...rows.map((r) => [clock(r.ts) + " " + new Date(r.ts * 1000).toISOString().slice(0, 10), r.broker, r.market, r.tf, r.side.toUpperCase(), r.conf, resText(r.result), r.step].join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "quantex-signals.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const printRows = () => {
    if (!rows.length) return onToast("No signals to print yet");
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(f);
    const d = f.contentDocument!;
    d.open();
    d.write(`<html><head><title>Signals</title><style>body{font:13px sans-serif;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px;text-align:left}</style></head><body><h3>QUANTEX signals</h3><table><tr><th>Time (UTC)</th><th>Broker</th><th>Market</th><th>TF</th><th>Side</th><th>Conf.</th><th>Result</th></tr>${rows.map((r) => `<tr><td>${new Date(r.ts * 1000).toISOString().slice(0, 19).replace("T", " ")}</td><td>${r.broker}</td><td>${r.market}</td><td>${r.tf}</td><td>${r.side.toUpperCase()}</td><td>${r.conf}%</td><td>${resText(r.result)}</td></tr>`).join("")}</table></body></html>`);
    d.close();
    setTimeout(() => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 2000); }, 250);
  };

  // ---------------------------------------------------- render
  if (view === "pack") {
    return (
      <div className="w-full min-h-screen bg-[#070b14] flex flex-col">
        <div className="bg-[#0a1020] border-b border-[#1c2944] px-4 py-2 flex items-center justify-between">
          <button
            onClick={() => setView("hub")}
            className="flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white bg-[#131f38] px-3 py-1.5 rounded-lg border border-[#1e2f54] transition cursor-pointer"
          >
            <ArrowLeft size={16} /> Back to Signals Hub
          </button>
          <span className="text-xs font-mono font-bold text-emerald-400">DERIV SYNTHETIC MATRIX</span>
        </div>
        <SignalPackageAgents
          http={apiBase}
          wsBase={wsBase}
          onOpenChart={(sym) => {
            setAsset(sym);
            onOpenChart();
          }}
          onToast={onToast}
          activeBalance={balance ?? null}
          isDemo={isDemo ?? true}
          onSwitchAccount={onSwitchAccount ?? (() => {})}
        />
      </div>
    );
  }

  if (view === "types") {

    return (
      <div className="sgwrap">
        <div className="sg">
          <DerivTradeTypes variant="page" current={derivType} onBack={() => setView("hub")} onPick={onPickDerivType} />
        </div>
      </div>
    );
  }

  if (view === "hub") {
    return (
      <div className="sgwrap">
        <div className="sg">
          <InstallBanner onToast={onToast} />
          <h1 className="sg-h1">Signals</h1>
          <p className="sg-sub">Every signal tool in one place.</p>
          <div className="sg-brk">
            <label className="sg-lbl">Broker</label>
            <label className="sg-sel"><select value={broker} onChange={(e) => setBroker(e.target.value)}>
              {BROKERS.filter((b) => b.ready).map((b) => <option key={b.id} value={b.id}>{b.name.toUpperCase()}</option>)}
            </select><ChevronDown size={16} /></label>
          </div>
          {CARDS.map((c) => (
            <div className="sg-card" key={c.id}>
              <div className="sg-card-top">
                <span className="sg-ico">{c.icon}</span>
                <div><h3>{c.title}</h3><p>{c.text}</p></div>
              </div>
              <button className="sg-grad" onClick={() => open(c.id)}>{c.cta}</button>
            </div>
          ))}
        </div>
        <button className="sg-bot" aria-label="AI assistant" onClick={() => onToast("AI assistant is coming soon")}><Bot size={24} /></button>
      </div>
    );
  }

  const sideCls = res ? (res.side === "buy" ? "buy" : "sell") : "";
  return (
    <div className="sgwrap">
      <div className="sg">
        <InstallBanner onToast={onToast} />
        <div className="sg-bar">
          <button className="sg-back" onClick={() => { setAuto(false); stop(); setView("hub"); }} aria-label="Back"><ArrowLeft size={20} /></button>
          <span className="sg-brand">QUANTEX <em>AI</em></span>
        </div>

        <div className="sg-card form">
          <label className="sg-lbl">Markets</label>
          <button className="sg-market" onClick={() => setPicker(true)}>
            <span className="sg-mname">{marketLabel}{otc && " (OTC)"}</span>
            {current?.payout != null && current.payout > 0 && <span className="sg-pay">{current.payout}%</span>}
            <ChevronDown size={18} />
          </button>
          <div className="sg-row3">
            <div><label className="sg-lbl">Broker</label>
              <label className="sg-sel"><select value={broker} onChange={(e) => { stop(); setPhase("idle"); setRes(null); setTrack(null); setErr(""); setBroker(e.target.value); }}>
                {BROKERS.filter((b) => b.ready).map((b) => (
                  <option key={b.id} value={b.id} disabled={!BINARY_BROKERS.includes(b.id)}>{b.name.toUpperCase()}{BINARY_BROKERS.includes(b.id) ? "" : " (SOON)"}</option>
                ))}
              </select><ChevronDown size={16} /></label></div>
            <div><label className="sg-lbl">Timeframe</label>
              <label className="sg-sel"><select value={tfSec} onChange={(e) => setTfSec(Number(e.target.value))}>
                {SIGNAL_TFS.map((t) => <option key={t.sec} value={t.sec}>{t.label}</option>)}
              </select><ChevronDown size={16} /></label></div>
            <div><label className="sg-lbl">Martingale</label>
              <label className="sg-sel"><select value={mtg} onChange={(e) => setMtg(Number(e.target.value))}>
                {MTG.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
              </select><ChevronDown size={16} /></label></div>
          </div>
          {!binary && <p className="sg-note">Live Signal is for binary-options brokers (Pocket Option, Quotex, IQ Option). Deriv has different contract types and comes later.</p>}
          <label className="sg-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><i /> Auto</label>
          {auto
            ? <button className="sg-grad wide sg-stop" onClick={() => { setAuto(false); scanId.current++; stop(); setPhase("idle"); setScan(null); }}>Stop Auto</button>
            : <button className="sg-grad wide" disabled={busy || !binary} onClick={() => { setAuto(false); run(); }}>{busy ? "Analyzing…" : "Generate signal"}</button>}
          <div className="sg-foot">
            <span className="sg-clock"><Clock size={18} /> <b>{clock(serverNow)}</b> UTC</span>
            <button className="sg-gear" onClick={() => setSettings((s) => !s)}><Settings size={18} /> Signal settings</button>
          </div>
          {settings && (
            <div className="sg-set">
              <label><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /><i /> Sound when a signal or result arrives</label>
              <label><input type="checkbox" checked={skipWeak} onChange={(e) => setSkipWeak(e.target.checked)} /><i /> In Auto, skip Low-confidence signals</label>
            </div>
          )}
        </div>

        <div className={`sg-card result ${sideCls} ${phase}`}>
          {phase === "idle" && !err && (
            <div className="sg-empty">
              <span className="sg-ico big"><ChartColumn size={24} /></span>
              <h3>No signal yet</h3>
              <p>Choose a market and press Generate signal. Results are checked automatically.</p>
            </div>
          )}
          {err && phase === "idle" && (
            <div className="sg-empty"><h3>Could not make a signal</h3><p>{err}</p></div>
          )}
          {phase === "analyzing" && (
            <div className="sg-an">
              <div className="sg-radar"><i /><i /><i /><Activity size={26} /></div>
              {scan ? (
                <>
                  <h3>Auto · scanning every {brokerName} market · {tfLabel}</h3>
                  <p className="sg-sub">{scan.total ? `${scan.done}/${scan.total} markets checked` : "Loading markets…"}{scan.pass > 1 ? ` · round ${scan.pass}` : ""}</p>
                  {scan.message && <p className="sg-sub">{scan.message}</p>}
                  {scan.total > 0 && <div className="sg-prog"><i style={{ width: `${Math.round((scan.done / scan.total) * 100)}%` }} /></div>}
                </>
              ) : (<>
              <h3>AI is analyzing {marketLabel}</h3>
              <ul>{STEPS.map((s, i) => <li key={s} className={i < step ? "ok" : i === step ? "now" : ""}>{i < step ? "✓" : i === step ? "●" : "○"} {s}</li>)}</ul></>)}
            </div>
          )}
          {phase === "done" && !res && none && (
            <div className="sg-empty"><h3>No high-probability setup</h3><p>{none}</p>{cond && <CondBox c={cond} setup="None" />}<p className="sg-sub">The engines check every closed candle. {auto ? "Auto is watching and will signal when one appears." : "Turn on Auto to be told when one appears."}</p></div>
          )}
          {phase === "done" && res && (
            <div className="sg-out">
              <div className="sg-meta">{shown?.label ?? marketLabel}{(shown?.otc ?? otc) && " OTC"} · {brokerName} · {tfLabel}</div>
              <div className="sg-hero">
                <div className="sg-ring" style={{ ["--c" as string]: res.confidence }}>
                  <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" className="bg" /><circle cx="60" cy="60" r="52" className="fg" pathLength={100} /></svg>
                  <div><b>{res.confidence}%</b><small>confidence</small></div>
                </div>
                <div className="sg-call">
                  <span className="sg-arrow">{res.side === "buy" ? <ArrowUp size={34} strokeWidth={3} /> : <ArrowDown size={34} strokeWidth={3} />}</span>
                  <strong>{res.side === "buy" ? "BUY" : "SELL"}</strong>
                  <span className="sg-tag">{res.side === "buy" ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {res.strength} strength</span>
                </div>
              </div>
              {sig && (
                <div className="sg-eng">
                  <span className={sig.sweep ? "on" : ""}>Sweep</span><span className={sig.ind >= 1 ? "on" : ""}>Indicators ×{sig.ind}</span><span className={sig.pattern ? "on" : ""}>Candle pattern</span>
                  <span className={sig.verified ? "on" : "off"}>{sig.verified ? "AI verified" : "AI not verified"}</span>
                </div>
              )}
              {sig && !sig.verified && <p className="sg-disc">Not verified by the AI: {sig.aiReason || "unavailable"}. Do not trade it automatically.</p>}
              {track && <Tracker track={track} now={serverNow} tfLabel={tfLabel} />}
              {cond && <CondBox c={cond} setup={setupName || "None"} />}
              <h4 className="sg-why">Why this signal</h4>
              <ul className="sg-reasons">
                {res.reasons.map((r, i) => (
                  <li key={i} className={r.bias} style={{ animationDelay: `${0.5 + i * 0.12}s` }}>
                    <span>{r.bias === "buy" ? "▲" : r.bias === "sell" ? "▼" : "•"}</span>{r.text}
                  </li>
                ))}
              </ul>
              <p className="sg-disc">Any engine can trigger a signal, more engines agreeing means higher confidence, and the AI checks the chart before it is verified. Confidence shows how many engines agree, not a chance of winning. Not financial advice.</p>
            </div>
          )}
        </div>

        <div className="sg-card hist">
          <div className="sg-hist-top"><h3>Signal history</h3>
            <div><button onClick={printRows}>Print</button><button onClick={printRows}>Download PDF</button><button onClick={exportCsv}>CSV</button>
              {rows.length > 0 && <button onClick={() => saveHistory(() => [])}>Clear</button>}</div></div>
          {!rows.length && <p className="sg-muted">Your signals and their results will be listed here.</p>}
          {rows.slice(0, 12).map((r) => (
            <div className="sg-hrow" key={r.id}>
              <span className={`sg-side ${r.side}`}>{r.side === "buy" ? "BUY" : "SELL"}</span>
              <span className="sg-hm">{r.market}<small>{r.broker} · {r.tf} · {clock(r.ts)} UTC</small></span>
              <span className="sg-hc">{r.conf}%</span>
              <span className={`sg-res ${r.result}`}>{resText(r.result)}{r.result === "win" && r.step > 0 ? ` MTG${r.step}` : ""}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 70 }} />
      </div>
      {picker && <MarketPicker broker={broker} assets={assets} selected={asset} onPick={(s) => { setAsset(s); setPicker(false); }} onClose={() => setPicker(false)} />}
      <button className="sg-bot" aria-label="AI assistant" onClick={() => onToast("AI assistant is coming soon")}><Bot size={24} /></button>
    </div>
  );
}

function Tracker({ track, now, tfLabel }: { track: Track; now: number; tfLabel: string }) {
  if (track.final === "skipped") return <div className="sg-track skipped">Skipped: confidence is Low. Next signal comes automatically.</div>;
  const first = track.entries[0];
  const wait = Math.max(0, Math.ceil(first.time - now));
  const live = track.entries.find((e) => e.result === "wait");
  const label = (e: Entry, i: number) => (i === 0 ? "Entry" : `MTG ${i}`);
  return (
    <div className={`sg-track ${track.final}`}>
      <div className="sg-trow">
        {track.entries.map((e, i) => (
          <span key={e.time} className={`sg-step ${e.result}`}>{label(e, i)} · {clock(e.time)}<b>{e.result === "wait" ? "…" : e.result.toUpperCase()}</b></span>
        ))}
        {track.mtg > track.entries.length - 1 && track.final === "pending" && <span className="sg-step dim">MTG {track.entries.length} if needed</span>}
      </div>
      <div className="sg-status">
        {track.final === "pending" && live === first && wait > 0 && <>Enter at <b>{clock(first.time)}</b> UTC for {tfLabel} · starts in <b>{wait}s</b></>}
        {track.final === "pending" && live && !(live === first && wait > 0) && <>Trade is running… result arrives automatically</>}
        {track.final === "win" && <>Result: <b>WIN</b></>}
        {track.final === "loss" && <>Result: <b>LOSS</b> after all steps</>}
        {track.final === "draw" && <>Result: <b>DRAW</b> (stake returned)</>}
        {track.final === "unknown" && <>Could not read the result from the feed</>}
      </div>
    </div>
  );
}
