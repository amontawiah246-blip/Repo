import React, { useEffect, useState } from "react";
import { Camera, Maximize, Pencil, RotateCcw, Settings, TrendingUp } from "lucide-react";
import { CHART_TYPES, ChartType } from "./assets";
import type { ChartHandle, Quote } from "./ChartView";

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

interface Props {
  chart: ChartHandle | null;
  chartType: ChartType;
  onType: (t: ChartType) => void;
  onReset: () => void;
  onToast: (msg: string) => void;
  onClose: () => void;
}

export default function ChartMenu({ chart, chartType, onType, onReset, onToast, onClose }: Props) {
  const [quote, setQuote] = useState<Quote | null>(() => chart?.getQuote() ?? null);

  useEffect(() => {
    const id = setInterval(() => setQuote(chart?.getQuote() ?? null), 250);
    return () => clearInterval(id);
  }, [chart]);

  const soon = (name: string) => () => onToast(`${name} are coming soon`);
  const run = (fn: () => Promise<string | void> | string | void) => async () => {
    const err = await fn();
    if (err) onToast(err);
    else onClose();
  };

  const tiles = [
    { id: "ind", label: "Indicators", icon: <TrendingUp size={22} />, onClick: soon("Indicators") },
    { id: "draw", label: "Drawing tools", icon: <Pencil size={22} />, onClick: soon("Drawing tools") },
    { id: "set", label: "Settings", icon: <Settings size={22} />, onClick: soon("Chart settings") },
    { id: "reset", label: "Reset chart", icon: <RotateCcw size={22} />, onClick: () => { onReset(); onClose(); } },
    { id: "shot", label: "Screenshot", icon: <Camera size={22} />, onClick: run(() => chart?.screenshot() ?? "Chart is not ready yet") },
    { id: "full", label: "Fullscreen", icon: <Maximize size={22} />, onClick: run(() => chart?.fullscreen() ?? "Chart is not ready yet") },
  ];

  const live = !!quote?.live;
  return (
    <>
      <div className="cm-dismiss" onClick={onClose} />
      <div className="cm" role="dialog" aria-label="Chart options">
        <div className="cm-handle" />
        <div className="cm-top">
          <b className={`cm-price ${quote && !quote.up ? "dn" : ""}`}>{quote?.price != null ? quote.price.toFixed(quote.dec) : "—"}</b>
          <span className="cm-timer">{quote ? mmss(quote.left) : "--:--"}</span>
          <span className={`cm-live ${live ? "on" : ""}`}><i />{live ? "LIVE" : "OFFLINE"}</span>
        </div>

        <div className="cm-body">
          <div className="cm-label">CHART TYPE</div>
          <div className="cm-types">
            {CHART_TYPES.map((t) => (
              <button key={t.id} className={chartType === t.id ? "on" : ""} onClick={() => onType(t.id)}>{t.label}</button>
            ))}
          </div>

          <div className="cm-tiles">
            {tiles.map((t) => (
              <button key={t.id} className="cm-tile" onClick={t.onClick}>
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
