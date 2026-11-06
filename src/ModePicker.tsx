import React from "react";
import { ChartLine, ChartNoAxesColumn, ChevronsUpDown, Sparkles } from "lucide-react";
import { MODES, Mode } from "./assets";

// The glowing outline of each mode (same idea as the Classic / Pro / AI Trader boxes in Pocket Option).
const GLOW: Record<Mode, { from: string; to: string }> = {
  classic: { from: "#3ea03a", to: "#d0342c" },
  pro: { from: "#2cc4f4", to: "#1d63d6" },
  ai: { from: "#7a6bff", to: "#c04fd8" },
};

export function ModeIcon({ mode, size = 30 }: { mode: Mode; size?: number }) {
  const inner = Math.round(size * 0.62);
  return (
    <span className="mode-ico" style={{ width: size, height: size }}>
      {mode === "classic" && <ChevronsUpDown size={inner} strokeWidth={2.2} />}
      {mode === "pro" && <ChartLine size={inner} strokeWidth={2.2} />}
      {mode === "ai" && (
        <>
          <ChartNoAxesColumn size={inner} strokeWidth={2.2} />
          <Sparkles size={Math.round(size * 0.36)} strokeWidth={2.2} className="spark" />
        </>
      )}
    </span>
  );
}

const glowStyle = (m: Mode) => ({ "--g1": GLOW[m].from, "--g2": GLOW[m].to } as React.CSSProperties);

/** The coloured box in the middle of the bottom bar. Tap it to open the three modes. */
export function ModeBox({ mode, open, onClick }: { mode: Mode; open: boolean; onClick: () => void }) {
  const label = MODES.find((m) => m.id === mode)?.label ?? "Classic mode";
  return (
    <button className={`modebox ${open ? "open" : ""}`} style={glowStyle(mode)} onClick={onClick} aria-haspopup="dialog" aria-expanded={open}>
      <ModeIcon mode={mode} size={26} />
      <span>{label}</span>
    </button>
  );
}

/** The three-box popup that appears above the bottom bar. */
export function ModePopup({ mode, onPick, onClose }: { mode: Mode; onPick: (m: Mode) => void; onClose: () => void }) {
  return (
    <>
      <div className="mp-scrim" onClick={onClose} />
      <div className="mp" role="dialog" aria-label="Choose a mode">
        {MODES.map((m) => (
          <button key={m.id} className={`mp-tile ${mode === m.id ? "on" : ""}`} style={glowStyle(m.id)} onClick={() => onPick(m.id)}>
            <ModeIcon mode={m.id} size={32} />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
