import React from "react";
import { BROKERS } from "./assets";

const MARKS: Record<string, { bg: string; fg: string; glyph: React.ReactNode }> = {
  deriv: {
    bg: "#ff444f",
    fg: "#ffffff",
    glyph: <b style={{ fontSize: 17, fontWeight: 900, letterSpacing: -0.5 }}>D</b>,
  },
  quotex: {
    bg: "#132145",
    fg: "#7ea5ff",
    glyph: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M5 18V8M9 18V5M13 18V9M17 18V6M21 18V10" />
      </svg>
    ),
  },
  iqoption: {
    bg: "#ff5a00",
    fg: "#ffffff",
    glyph: <b style={{ fontSize: 14, fontWeight: 900, letterSpacing: -0.5 }}>IQ</b>,
  },
  pocket: {
    bg: "#063d27",
    fg: "#34d399",
    glyph: <b style={{ fontSize: 17, fontWeight: 900 }}>P</b>,
  },
};

export function BrokerLogo({ id, size = 38 }: { id: string; size?: number }) {
  const m = MARKS[id] || MARKS.pocket;
  return (
    <span className="blogo" style={{ background: m.bg, color: m.fg, width: size, height: size }}>
      {m.glyph}
    </span>
  );
}

interface Props {
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

export default function BrokerMenu({ current, onPick, onClose }: Props) {
  return (
    <div className="bm-scrim" onClick={onClose}>
      <div className="bm-dropdown" role="listbox" aria-label="Select Broker" onClick={(e) => e.stopPropagation()}>
        <div className="bm-head">
          <div className="bm-title">SELECT BROKER</div>
          <button className="bm-close" onClick={onClose} aria-label="Close menu">✕</button>
        </div>

        <div className="bm-list">
          {BROKERS.map((b) => {
            const isSelected = current === b.id;
            return (
              <button
                key={b.id}
                role="option"
                aria-selected={isSelected}
                disabled={!b.ready}
                className={`bm-item ${isSelected ? "sel" : ""} ${!b.ready ? "disabled" : ""}`}
                onClick={() => {
                  if (b.ready) {
                    onPick(b.id);
                  }
                }}
              >
                <BrokerLogo id={b.id} size={36} />
                <div className="bm-details">
                  <div className="bm-name-row">
                    <span className="bm-name">{b.name}</span>
                    {isSelected && <span className="bm-active-badge">Active</span>}
                  </div>
                  <span className="bm-desc">
                    {b.ready ? (b.note || "Live Feed Ready") : "Coming Soon"}
                  </span>
                </div>
                {isSelected ? (
                  <span className="bm-check">✓</span>
                ) : (
                  <span className="bm-arrow">›</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
