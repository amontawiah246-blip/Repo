import React, { useEffect, useRef, useState } from "react";
import { Activity, ChartColumn, ChevronDown, Ellipsis, House, Menu as MenuIcon, Wallet, Zap } from "lucide-react";
import ChartView, { ChartHandle } from "./ChartView";
import Sheet from "./Sheet";
import { BrokerLogo } from "./BrokerMenu";
import MarketPicker from "./MarketPicker";
import MarketIcon from "./MarketIcon";
import ChartMenu from "./ChartMenu";
import TradePanel from "./TradePanel";
import { Home, Api, Menu, StatusData } from "./Pages";
import SignalsPage from "./SignalsPage";
import SignalPackageAgents from "./SignalPackageAgents";
import DerivTradeTypes from "./DerivTradeTypes";
import { DEFAULT_DERIV_TYPE, DERIV_TYPES, derivTypeOf } from "./derivTypes";
import { apiFetch } from "./api";
import { shortName, splitName, TIMEFRAMES, Asset, ChartType, CHART_TYPES, Mode, MODES } from "./assets";
import "./styles.css";

const defaultBridge = () => {
  if (typeof window === "undefined") return "localhost:3000";
  const saved = localStorage.getItem("bridge");
  if (saved && !saved.includes(":8765")) {
    return saved;
  }
  return location.host;
};

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

export default function App() {
  const [tab, setTab] = useState<string>("chart");
  const [bridge, setBridgeState] = useState(defaultBridge);
  const [broker] = useState("deriv"); // Deriv is exclusively used
  const [asset, setAsset] = useState("1HZ100V"); // Default Deriv synthetic volatility index
  const [tf, setTf] = useState(60);
  const [sheet, setSheet] = useState<string | null>(null); // pair | tf | more
  const [assets, setAssets] = useState<Asset[]>([]);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [chartType, setChartTypeState] = useState<ChartType>(() => remembered("qx-chart-type", CHART_TYPES.map((c) => c.id), "candles"));
  const [derivType, setDerivTypeState] = useState<string>(() => remembered("qx-deriv-type", DERIV_TYPES.map((t) => t.id), DEFAULT_DERIV_TYPE));
  const [typePicker, setTypePicker] = useState(false);
  const [toast, setToast] = useState("");
  const chartRef = useRef<ChartHandle>(null);

  const setBridge = (v: string) => {
    localStorage.setItem("bridge", v);
    setBridgeState(v);
  };
  const setChartType = (t: ChartType) => {
    setChartTypeState(t);
    remember("qx-chart-type", t);
  };
  const pickDerivType = (id: string) => {
    setDerivTypeState(id);
    remember("qx-deriv-type", id);
    setTypePicker(false);
    setSheet(null);
    setTab("chart");
    setToast(`${derivTypeOf(id).label} selected`);
  };

  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const isLocal = bridge.includes("localhost") || bridge.includes("127.0.0.1");
  const httpProto = isHttps && !isLocal ? "https" : "http";
  const wsProto = isHttps && !isLocal ? "wss" : "ws";
  const http = bridge.startsWith("http") ? bridge : `${httpProto}://${bridge}`;
  const wsBase = bridge.startsWith("ws") ? bridge : `${wsProto}://${bridge}`;

  // Status + asset list from Deriv
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const sRes = await fetch(`${http}/api/status?broker=deriv`);
        if (sRes.ok) {
          const s = await sRes.json();
          if (!dead) setStatus(s);
        } else if (!dead) {
          setStatus(null);
        }

        const aRes = await fetch(`${http}/api/assets?broker=deriv`);
        if (aRes.ok) {
          const a = await aRes.json();
          if (!dead && Array.isArray(a)) {
            setAssets(a);
            if (a.length > 0 && !a.some((x) => x.symbol === asset)) {
              setAsset(a[0].symbol);
            }
          }
        }
      } catch {
        if (!dead) setStatus(null);
      }
    };
    load();
    const id = setInterval(load, status?.ready ? 30000 : 3000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [http, status?.ready, asset]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const current = assets.find((a) => a.symbol === asset);
  const currentAsset: Asset = current ?? { symbol: asset, name: "Volatility 100 (1s) Index" };
  const tfLabel = TIMEFRAMES.find((t) => t.sec === tf)?.label ?? "1m";

  const close = () => setSheet(null);

  const switchAccount = async (demo: boolean) => {
    setToast(`Switching Deriv account to ${demo ? "DEMO" : "REAL"}…`);
    try {
      const r = await apiFetch(`${http}/api/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: "deriv", demo }),
      });
      const d = await r.json();
      if (d.status !== "ok") {
        setToast(d.msg || "Could not switch the account");
        return;
      }
      for (let i = 0; i < 8; i++) {
        await new Promise((res) => setTimeout(res, 1200));
        const sr = await fetch(`${http}/api/status?broker=deriv`);
        const st = await sr.json();
        if (st.ready && st.demo === demo) {
          setStatus(st);
          setToast(`Now trading on Deriv ${demo ? "DEMO" : "REAL"} account`);
          return;
        }
      }
      setToast("Account switched. Deriv balance updated.");
    } catch {
      setToast("Could not reach the server");
    }
  };

  const go = (id: string) => {
    setTab(id);
    setSheet(null);
    setTypePicker(false);
  };
  const toggleSheet = (id: string) => {
    setSheet((s) => (s === id ? null : id));
  };

  const navBtn = (id: string, name: string, icon: React.ReactNode) => (
    <button key={id} className={tab === id ? "on" : ""} onClick={() => go(id)}>
      {icon}
      <span>{name}</span>
    </button>
  );

  return (
    <div className="app">
      {tab === "chart" && (
        <header className="top">
          {/* Deriv Broker & Account Live Badge */}
          <button
            className="chip brk flex items-center gap-1.5 px-3 py-1 bg-[#101b33] border border-[#1e2f52] rounded-xl hover:border-blue-500/50 transition cursor-pointer"
            onClick={() => switchAccount(!status?.demo)}
            title="Click to switch Demo / Real account"
          >
            <BrokerLogo id="deriv" size={24} />
            <span className="font-bold text-xs text-white">DERIV</span>
            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                status?.demo ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              }`}
            >
              {status?.demo ? "DEMO" : "REAL"}
            </span>
            {status?.balance != null && (
              <span className="text-xs font-mono font-bold text-emerald-400 ml-1">
                ${status.balance.toFixed(2)}
              </span>
            )}
          </button>

          {/* Synthetic Market Selector */}
          <button className={`chip pair ${sheet === "pair" ? "open" : ""}`} onClick={() => toggleSheet("pair")}>
            <MarketIcon asset={currentAsset} small />
            <span className="nm">{shortName(currentAsset)}</span>
            {current?.payout != null && current.payout > 0 && <em>{current.payout}%</em>}
            <ChevronDown size={16} className="chev" />
          </button>

          {/* Timeframe Selector */}
          <button className="chip tfc" onClick={() => toggleSheet("tf")}>
            {tfLabel}
            <ChevronDown size={16} />
          </button>

          {/* Chart Options */}
          <button className={`icon dots ${sheet === "more" ? "on" : ""}`} onClick={() => toggleSheet("more")} aria-label="Chart options">
            <Ellipsis size={20} />
          </button>
        </header>
      )}

      <main>
        {tab === "home" && <Home status={status} brokerName="Deriv" onOpenChart={() => go("chart")} onSwitchAccount={switchAccount} />}

        {tab === "package" && (
          <SignalPackageAgents
            http={http}
            wsBase={wsBase}
            onOpenChart={(sym) => {
              setAsset(sym);
              go("chart");
            }}
            onToast={setToast}
            activeBalance={status?.balance ?? null}
            isDemo={status?.demo ?? true}
            onSwitchAccount={switchAccount}
          />
        )}

        {tab === "signals" && (
          <SignalsPage
            wsBase={wsBase}
            apiBase={http}
            broker="deriv"
            setBroker={() => {}}
            asset={asset}
            setAsset={setAsset}
            assets={assets}
            onOpenChart={() => go("chart")}
            onToast={setToast}
            derivType={derivType}
            onPickDerivType={pickDerivType}
            balance={status?.balance}
            isDemo={status?.demo}
            onSwitchAccount={switchAccount}
          />
        )}

        {tab === "chart" && (
          <ChartView ref={chartRef} wsBase={wsBase} broker="deriv" asset={asset} tf={tf} reloadKey={reloadKey} chartType={chartType} />
        )}

        {tab === "chart" && (
          <TradePanel
            http={http}
            broker="deriv"
            asset={asset}
            assetLabel={splitName(currentAsset).label}
            payout={current?.payout ?? 95}
            closed={current?.active === false}
            mode="classic"
            onToast={setToast}
          />
        )}

        {tab === "api" && <Api bridge={bridge} setBridge={setBridge} broker="deriv" status={status} />}
        {tab === "menu" && <Menu />}

        {tab === "chart" && typePicker && (
          <DerivTradeTypes variant="overlay" current={derivType} onBack={() => setTypePicker(false)} onPick={pickDerivType} />
        )}

        {tab === "chart" && sheet === "pair" && (
          <MarketPicker broker="deriv" assets={assets} selected={asset} onPick={(s) => { setAsset(s); close(); }} onClose={close} />
        )}

        {tab === "chart" && sheet === "more" && (
          <ChartMenu
            chart={chartRef.current}
            chartType={chartType}
            onType={setChartType}
            onReset={() => setReloadKey((k) => k + 1)}
            onToast={setToast}
            onClose={close}
          />
        )}
      </main>

      {toast && <div className="toast" role="status">{toast}</div>}

      <div className="navwrap">
        <nav className="bottom">
          {navBtn("chart", "Live Chart", <ChartColumn size={20} />)}
          {navBtn("package", "Signal Package", <Zap size={20} className={tab === "package" ? "text-emerald-400" : ""} />)}
          {navBtn("signals", "Signals", <Activity size={20} />)}
          {navBtn("home", "Account", <Wallet size={20} />)}
          {navBtn("menu", "Menu", <MenuIcon size={20} />)}
        </nav>
      </div>

      {sheet === "tf" && (
        <Sheet title="Timeframe" onClose={close}>
          {TIMEFRAMES.map((t) => (
            <button key={t.sec} className={`item ${t.sec === tf ? "sel" : ""}`} onClick={() => { setTf(t.sec); close(); }}>
              <span>{t.label}</span>
            </button>
          ))}
        </Sheet>
      )}
    </div>
  );
}
