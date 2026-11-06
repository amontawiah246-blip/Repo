import React, { useState } from "react";
import {
  Activity, ArrowDownRight, ArrowLeft, ArrowUpRight, ChevronsDown, ChevronsUp, CircleOff, Equal, EqualNot,
  Maximize2, Minimize2, MoveDownRight, MoveUpRight, Square, Target, Triangle, TrendingDown, TrendingUp, X,
} from "lucide-react";
import { DERIV_PLATFORMS, DERIV_TYPES, DerivPlatform } from "./derivTypes";

const S = 26;
// Each trade type shows a pair of small glyphs, like Deriv's own screen: the first one coral, the second one slate-teal.
const GLYPHS: Record<string, [React.ReactNode, React.ReactNode]> = {
  risefall: [<TrendingUp size={S} />, <TrendingDown size={S} />],
  higherlower: [<ArrowUpRight size={S} />, <ArrowDownRight size={S} />],
  matchesdiffers: [<Equal size={S} />, <EqualNot size={S} />],
  evenodd: [<Square size={S} />, <Triangle size={S} />],
  accumulators: [<Activity size={S} />, <Activity size={S} />],
  overunder: [<ChevronsUp size={S} />, <ChevronsDown size={S} />],
  multipliers: [<Maximize2 size={S} />, <Minimize2 size={S} />],
  touch: [<Target size={S} />, <CircleOff size={S} />],
  vanillas: [<MoveUpRight size={S} />, <MoveDownRight size={S} />],
  turbos: [<TrendingUp size={S} />, <TrendingDown size={S} />],
};

interface Props {
  /** the type that is active right now */
  current: string;
  onPick: (id: string) => void;
  /** page: full page inside Signals (back arrow). overlay: panel over the chart (close button). */
  variant: "page" | "overlay";
  onBack: () => void;
}

/** "Trade types" picker. Tapping a type calls onPick; the caller opens Pro mode. */
export default function DerivTradeTypes({ current, onPick, variant, onBack }: Props) {
  const [platform, setPlatform] = useState<DerivPlatform["id"]>("trader");
  const body = (
    <div className="dt">
      <div className="dt-bar">
        <button className="sg-back" onClick={onBack} aria-label={variant === "page" ? "Back" : "Close"}>
          {variant === "page" ? <ArrowLeft size={20} /> : <X size={20} />}
        </button>
        <span className="dt-title">{variant === "page" ? "Future Signals" : "Trade type"}</span>
        <span className="dt-pill">DERIV</span>
      </div>

      <h2 className="dt-h2">Trade types</h2>
      <div className="dt-tabs" role="tablist">
        {DERIV_PLATFORMS.map((p) => (
          <button key={p.id} role="tab" aria-selected={platform === p.id} className={platform === p.id ? "on" : ""} onClick={() => setPlatform(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      {platform === "trader" ? (
        <div className="dt-grid">
          {DERIV_TYPES.map((t) => (
            <button key={t.id} className={`dt-tile ${current === t.id ? "sel" : ""}`} onClick={() => onPick(t.id)}>
              <span className="dt-ico">
                <i className="a">{GLYPHS[t.id][0]}</i>
                <i className="b">{GLYPHS[t.id][1]}</i>
              </span>
              <span className="dt-lbl">{t.label}</span>
              {!t.tradable && <small>signals only</small>}
            </button>
          ))}
        </div>
      ) : (
        <p className="dt-empty">
          The {DERIV_PLATFORMS.find((p) => p.id === platform)?.label} trade types are not added yet. Deriv Trader has the full list.
        </p>
      )}
      <p className="dt-foot">Pick a type and Pro mode opens with it. Only Rise/Fall can place trades right now.</p>
    </div>
  );
  return variant === "overlay" ? <div className="dt-over">{body}</div> : body;
}
