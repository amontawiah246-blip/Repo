import React, { useEffect, useRef, useState } from "react";
import { Square, X } from "lucide-react";
import { apiFetch } from "./api";
import { AutoConfig, AutoState, DEFAULT_CFG } from "./autopilot";

const CFG_KEY = "qx-auto-cfg";
export const loadCfg = (): AutoConfig => {
  try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") }; } catch { return { ...DEFAULT_CFG }; }
};
const saveCfg = (c: AutoConfig) => { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* storage unavailable */ } };

// ---------------------------------------------------------------- the bot runs on the server; this only starts, stops and watches it
export function useAutopilot(http: string) {
  const [st, setSt] = useState<AutoState | null>(null);
  const [cfg, setCfg] = useState<AutoConfig | null>(null);
  const [broker, setBroker] = useState("");
  const [active, setActive] = useState(false);
  const alive = useRef(true);
  const fast = useRef(false);

  const poll = async () => {
    try {
      const r = await apiFetch(`${http}/api/auto/state`);
      if (!r.ok) return;
      const d = await r.json();
      if (!alive.current) return;
      const skew = Date.now() - (d.now ?? Date.now());      // server clock to this device's clock
      const s: AutoState | null = d.state ? { ...d.state, trade: d.state.trade ? { ...d.state.trade, endsAt: d.state.trade.endsAt + skew } : null } : null;
      setSt(s); setCfg(d.cfg ?? null); setBroker(d.broker ?? ""); setActive(!!d.active); fast.current = !!d.active;
    } catch { /* server unreachable: keep the last picture */ }
  };
  useEffect(() => {
    alive.current = true; void poll();
    const id = setInterval(() => void poll(), 1500);
    return () => { alive.current = false; clearInterval(id); };
  }, [http]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (brokerId: string, c: AutoConfig & Record<string, unknown>): Promise<string> => {
    try {
      const r = await apiFetch(`${http}/api/auto/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: brokerId, cfg: c }) });
      const d = await r.json();
      if (d.status !== "ok") return d.msg || "Could not start";
      await poll(); return "";
    } catch { return "Could not reach the server"; }
  };
  const stop = async () => { try { await apiFetch(`${http}/api/auto/stop`, { method: "POST" }); } catch { /* ignore */ } await poll(); };
  const dismiss = async () => { try { await apiFetch(`${http}/api/auto/clear`, { method: "POST" }); } catch { /* ignore */ } setSt(null); setCfg(null); await poll(); };
  return { st, cfg, broker, running: active, start, stop, dismiss };
}

// ---------------------------------------------------------------- confirmation + settings
const TFS = [{ l: "S30", s: 30 }, { l: "M1", s: 60 }, { l: "M5", s: 300 }];

export function AutopilotModal({ brokerName, broker, account, defaultStake, onStart, onCancel, onSwitchAccount }: {
  brokerName: string; broker: string; account: "DEMO" | "REAL" | "UNKNOWN"; defaultStake: number; onStart: (c: AutoConfig) => void; onCancel: () => void; onSwitchAccount?: (demo: boolean) => void;
}) {
  const tfs = broker === "iqoption" ? TFS.filter((t) => t.s >= 60) : TFS;
  const [cfg, setCfg] = useState<AutoConfig>(() => { const c = loadCfg(); return { ...c, stake: defaultStake > 0 ? defaultStake : c.stake }; });
  const [ok, setOk] = useState(false);
  const num = (k: keyof AutoConfig, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setCfg((c) => ({ ...c, [k]: Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min }));
  };
  const valid = cfg.stake > 0 && cfg.maxTrades >= 1;
  const tfSec = tfs.some((t) => t.s === cfg.tfSec) ? cfg.tfSec : 60;
  return (
    <div className="ap-scrim" role="dialog" aria-label="AI Trading">
      <div className="ap-modal">
        <button className="ap-close" onClick={onCancel} aria-label="Close"><X size={22} /></button>
        <h3>Welcome to a new era of trading!</h3>
        <p>Tap start and the AI scans the open markets, switches to the strongest setup, places the trade for you and follows the result. It repeats until you stop it or a limit below is reached.</p>
        <div className={`ap-acct ${account.toLowerCase()}`}>
          Trading on <b>{brokerName}</b> · <b>{account === "UNKNOWN" ? "account type not known" : `${account} account`}</b>
          {account !== "DEMO" && <span> Real orders can lose real money.</span>}
          {onSwitchAccount && account !== "UNKNOWN" && (
            <span className="acctsw"><button className={account === "DEMO" ? "on" : ""} onClick={() => account !== "DEMO" && onSwitchAccount(true)}>Demo</button><button className={account === "REAL" ? "on real" : ""} onClick={() => account !== "REAL" && onSwitchAccount(false)}>Real</button></span>
          )}
        </div>

        <div className="ap-grid">
          <label>Amount per trade<input inputMode="decimal" value={cfg.stake} onChange={num("stake", 0, 100000)} /></label>
          <label>Max trades<input inputMode="numeric" value={cfg.maxTrades} onChange={num("maxTrades", 1, 500)} /></label>
          <label>Stop after losses in a row<input inputMode="numeric" value={cfg.maxLossStreak} onChange={num("maxLossStreak", 1, 20)} /></label>
          <label>Stop when down by<input inputMode="decimal" value={cfg.stopLoss} onChange={num("stopLoss", 1, 1000000)} /></label>
        </div>
        <div className="ap-row"><span>Expiry</span>
          <div className="ap-chips">{tfs.map((t) => <button key={t.s} className={tfSec === t.s ? "on" : ""} onClick={() => setCfg({ ...cfg, tfSec: t.s })}>{t.l}</button>)}</div></div>
        <div className="ap-row"><span>Minimum confidence <b>{cfg.minConf}%</b></span>
          <input type="range" min={55} max={90} step={1} value={cfg.minConf} onChange={(e) => setCfg({ ...cfg, minConf: Number(e.target.value) })} /></div>
        <div className="ap-row"><span>Minimum payout <b>{cfg.minPayout}%</b></span>
          <input type="range" min={80} max={95} step={1} value={cfg.minPayout} onChange={(e) => setCfg({ ...cfg, minPayout: Number(e.target.value) })} /></div>
        <p className="ap-hint">{broker === "deriv" ? "Deriv sets the payout per trade, so every open Deriv market is scanned." : `Only markets paying ${cfg.minPayout}%+ are traded.`} Sweep alone 62%, one indicator 60%, a pattern alone 58%; sweep + indicators 72%+, pattern + indicators 68%+, all three 80%+. Every trade is checked by the AI first. No martingale.</p>

        <label className="ap-agree"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /><i />
          <span>I understand the AI places trades automatically and I can lose my stake.</span></label>
        <button className="ap-start" disabled={!ok || !valid} onClick={() => { const c = { ...cfg, tfSec }; saveCfg(c); onStart(c); }}>Start AI Trading</button>
        <button className="ap-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live status card
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function AutopilotCard({ st, cfg, running, brokerLabel, onStop, onDismiss }: { st: AutoState; cfg: AutoConfig; running: boolean; brokerLabel?: string; onStop: () => void; onDismiss: () => void }) {
  const [, tick] = useState(0);
  const [more, setMore] = useState(false);
  useEffect(() => { if (!running) return; const id = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(id); }, [running]);
  const done = st.scan.filter((r) => r.state === "done" || r.state === "fail").length;
  let line = "Starting…";
  if (st.phase === "scanning") line = `Scanning markets ${done}/${st.scan.length}`;
  else if (st.phase === "confirming") line = "Checking the setup once more";
  else if (st.phase === "running" && st.trade) line = `${st.trade.side === "buy" ? "BUY" : "SELL"} ${st.trade.label} · ${mmss(st.trade.endsAt - Date.now())} left`;
  else if (st.phase === "cooldown") line = "Looking for the next setup";
  else if (st.phase === "stopped") line = st.stopReason || "Stopped";
  const s = st.stats;
  return (
    <div className={`apc ${st.phase}`}>
      <div className="apc-top">
        <i className="apc-dot" />
        <span className="apc-line">{line}</span>
        {running ? <button className="apc-stop" onClick={onStop}><Square size={13} fill="currentColor" /> Stop</button>
          : <button className="apc-stop ghost" onClick={onDismiss}>Close</button>}
      </div>
      <div className="apc-stats">
        {brokerLabel && <span className="apc-br">{brokerLabel}</span>}
        <span>Trades <b>{s.trades}/{cfg.maxTrades}</b></span>
        <span className="w">W <b>{s.wins}</b></span><span className="l">L <b>{s.losses}</b></span>
        <span className={s.pnl >= 0 ? "w" : "l"}>P&amp;L <b>{s.pnl > 0 ? "+" : ""}{s.pnl}</b>{s.estimated > 0 && <small> ({s.estimated} est.)</small>} </span>
        <button className="apc-more" onClick={() => setMore((m) => !m)}>{more ? "Less" : "Details"}</button>
      </div>
      {st.phase === "running" && st.trade && <div className="apc-bar"><i style={{ width: `${Math.min(100, 100 - ((st.trade.endsAt - Date.now()) / (st.trade.seconds * 1000)) * 100)}%` }} /></div>}
      <div className="apc-chips">
        {st.scan.length > 8 && <span className="apc-chip wait">{st.scan.filter((r) => r.state === "done" || r.state === "fail").length}/{st.scan.length} markets</span>}
        {st.scan.filter((r) => st.scan.length <= 8 || r.state === "scan" || (r.conf ?? 0) > 0).slice(0, 8).map((r) => (
          <span key={r.symbol} className={`apc-chip ${r.state} ${r.side ?? ""} ${r.conf != null && r.conf >= cfg.minConf ? "hit" : ""}`}>
            {r.label}{r.state === "done" && <b>{r.side === "buy" ? "▲" : "▼"} {r.conf}%</b>}{r.state === "scan" && <b>…</b>}{r.state === "fail" && <b>–</b>}
          </span>
        ))}
      </div>
      {more && <ul className="apc-log">{st.log.slice(0, 8).map((l, i) => <li key={i} className={l.kind}>{new Date(l.t).toTimeString().slice(0, 8)} {l.text}</li>)}</ul>}
    </div>
  );
}
