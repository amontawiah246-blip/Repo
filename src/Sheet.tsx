import React from 'react';

interface SheetProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

// Bottom sheet used by every dropdown (broker, pair, timeframe, menu).
export default function Sheet({ title, onClose, children }: SheetProps) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
