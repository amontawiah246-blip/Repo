import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Star, X } from "lucide-react";
import { Asset, Kind, kindOf, prettyName, splitName } from "./assets";
import MarketIcon from "./MarketIcon";

type Tab = "all" | "fav" | "1s" | "vol" | "crash_boom" | "jump_step";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All Synthetics" },
  { id: "fav", label: "Favorites" },
  { id: "1s", label: "1s Volatility" },
  { id: "vol", label: "Continuous Vol" },
  { id: "crash_boom", label: "Crash & Boom" },
  { id: "jump_step", label: "Step & Jump" },
];

// Favourites are remembered per broker in this browser.
function useFavorites(broker: string) {
  const key = `qx-fav-${broker}`;
  const read = (): string[] => {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
  };
  const [favs, setFavs] = useState<string[]>(read);
  useEffect(() => { setFavs(read()); }, [key]);
  const toggle = (symbol: string) => {
    setFavs((cur) => {
      const next = cur.includes(symbol) ? cur.filter((s) => s !== symbol) : [...cur, symbol];
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };
  return { favs, toggle };
}

interface Props {
  broker: string;
  assets: Asset[];
  selected: string;
  onPick: (symbol: string) => void;
  onClose: () => void;
}

export default function MarketPicker({ broker, assets, selected, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const { favs, toggle } = useFavorites(broker);
  const selRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const tabs = TABS;

  useEffect(() => {
    // open with the current market in view (scroll the list only, never the page behind it)
    const list = listRef.current, row = selRef.current;
    if (list && row) list.scrollTop = row.offsetTop - (list.clientHeight - row.clientHeight) / 2;
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, "");
    return assets
      .filter((a) => {
        if (tab === "fav") return favs.includes(a.symbol);
        if (tab === "all") return true;
        const s = a.symbol.toUpperCase();
        if (tab === "1s") return s.startsWith("1HZ");
        if (tab === "vol") return s.startsWith("R_");
        if (tab === "crash_boom") return s.startsWith("BOOM") || s.startsWith("CRASH");
        if (tab === "jump_step") return s.startsWith("JD") || s.startsWith("STP") || s.startsWith("RB") || s.startsWith("RD");
        return true;
      })
      .filter((a) => !needle || (prettyName(a) + a.symbol).toLowerCase().replace(/[\s/_-]/g, "").includes(needle.replace(/[/_-]/g, "")))
      .sort((x, y) => (y.payout ?? 0) - (x.payout ?? 0) || prettyName(x).localeCompare(prettyName(y), undefined, { numeric: true }));
  }, [assets, q, tab, favs]);


  return (
    <div className="mk" role="dialog" aria-label="Select a market">
      <div className="mk-search">
        <label className="mk-input">
          <Search size={16} />
          <input autoFocus={false} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a market, e.g. EUR/USD"
            spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        </label>
        <button className="mk-x" onClick={onClose} aria-label="Close"><X size={20} /></button>
      </div>

      <div className="mk-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.id === "fav" && <Star size={13} fill="currentColor" strokeWidth={0} />}
            {t.label}
          </button>
        ))}
      </div>

      <div className="mk-list" ref={listRef}>
        {!assets.length && <p className="mk-empty">Markets load once the bridge is connected.</p>}
        {!!assets.length && !rows.length && (
          <p className="mk-empty">{tab === "fav" && !q ? "Tap a star to add a market to your favorites." : "No markets found."}</p>
        )}
        {rows.map((a) => {
          const { label, otc } = splitName(a);
          const isSel = a.symbol === selected;
          const isFav = favs.includes(a.symbol);
          const closed = a.active === false;
          return (
            <div key={a.symbol} ref={isSel ? selRef : undefined} className={`mk-row ${isSel ? "sel" : ""} ${closed ? "closed" : ""}`}>
              <button className={`mk-star ${isFav ? "on" : ""}`} onClick={() => toggle(a.symbol)}
                aria-label={isFav ? "Remove from favorites" : "Add to favorites"} aria-pressed={isFav}>
                <Star size={17} strokeWidth={1.8} fill={isFav ? "currentColor" : "none"} />
              </button>
              <button className="mk-pick" disabled={closed} onClick={() => onPick(a.symbol)}>
                <MarketIcon asset={a} />
                <span className="mk-name">{label}</span>
                {otc && <span className="mk-otc">OTC</span>}
                <span className={`mk-pay ${!closed && !(a.payout && a.payout > 0) ? "live" : ""}`}>{closed ? "Closed" : a.payout && a.payout > 0 ? `${a.payout}%` : "Live"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
